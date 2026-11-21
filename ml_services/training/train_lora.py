"""Codiz Automated QLoRA / LoRA Fine-Tuning Job Runner.

Designed for low-VRAM GPUs (8GB-24GB, e.g. Cloud Run L4 or local RTX 3060/4060).
Runs completely independently of the Hono API Gateway process.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
from trl import SFTTrainer


def download_gcs_if_needed(uri: str, local_dest: Path) -> Path:
    if uri.startswith("gs://"):
        from google.cloud import storage

        bucket_name, blob_path = uri[5:].split("/", 1)
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        local_dest.parent.mkdir(parents=True, exist_ok=True)
        bucket.blob(blob_path).download_to_filename(str(local_dest))
        return local_dest
    return Path(uri.replace("local://artifacts/", ".codiz-data/artifacts/"))


def upload_directory_to_gcs(local_dir: Path, gcs_prefix_uri: str) -> None:
    if not gcs_prefix_uri.startswith("gs://"):
        return
    from google.cloud import storage

    bucket_name, prefix = gcs_prefix_uri[5:].split("/", 1)
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    for file_path in local_dir.rglob("*"):
        if file_path.is_file():
            rel = file_path.relative_to(local_dir).as_posix()
            bucket.blob(f"{prefix}/{rel}").upload_from_filename(str(file_path))


def compute_dir_sha256(directory: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(directory.rglob("*.safetensors")):
        h.update(p.read_bytes())
    return h.hexdigest()


def run_training(manifest_path: Path, output_root: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    foundation_model: str = manifest["foundationModel"]
    adapter_version: str = manifest["adapterVersion"]
    lora_cfg: dict[str, Any] = manifest["loraConfig"]

    work_dir = output_root / adapter_version
    work_dir.mkdir(parents=True, exist_ok=True)

    train_file = download_gcs_if_needed(manifest["trainDatasetUri"], work_dir / "train.jsonl")
    val_file = download_gcs_if_needed(manifest["valDatasetUri"], work_dir / "val.jsonl")

    dataset = load_dataset(
        "json",
        data_files={"train": str(train_file), "validation": str(val_file)},
    )

    tokenizer = AutoTokenizer.from_pretrained(foundation_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    use_4bit = int(lora_cfg.get("quantizationBits", 4)) == 4 and torch.cuda.is_available()
    bnb_config = (
        BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
        if use_4bit
        else None
    )

    model = AutoModelForCausalLM.from_pretrained(
        foundation_model,
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
    )
    model.config.use_cache = False
    if use_4bit:
        model = prepare_model_for_kbit_training(model)

    peft_config = LoraConfig(
        r=int(lora_cfg.get("rank", 16)),
        lora_alpha=int(lora_cfg.get("alpha", 32)),
        lora_dropout=float(lora_cfg.get("dropout", 0.05)),
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=lora_cfg.get(
            "targetModules",
            ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
    )

    training_args = TrainingArguments(
        output_dir=str(work_dir / "checkpoints"),
        per_device_train_batch_size=int(lora_cfg.get("batchSize", 2)),
        gradient_accumulation_steps=4,
        gradient_checkpointing=True,
        learning_rate=float(lora_cfg.get("learningRate", 2e-4)),
        num_train_epochs=int(lora_cfg.get("epochs", 2)),
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        bf16=torch.cuda.is_available(),
        optim="paged_adamw_8bit" if use_4bit else "adamw_torch",
        report_to="none",
        save_safetensors=True,
    )

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"],
        peft_config=peft_config,
        processing_class=tokenizer,
    )

    train_result = trainer.train()
    eval_metrics = trainer.evaluate()

    adapter_out = work_dir / "adapter"
    trainer.model.save_pretrained(str(adapter_out), safe_serialization=True)
    tokenizer.save_pretrained(str(adapter_out))

    sha256 = compute_dir_sha256(adapter_out)
    bucket = os.getenv("GCS_BUCKET_NAME", "")
    if bucket:
        upload_directory_to_gcs(adapter_out, f"gs://{bucket}/adapters/candidates/{adapter_version}")

    summary = {
        "runId": manifest["runId"],
        "adapterVersion": adapter_version,
        "trainLoss": float(train_result.training_loss),
        "valLoss": float(eval_metrics.get("eval_loss", 0.0)),
        "sha256": sha256,
        "adapterPath": str(adapter_out),
    }
    (work_dir / "training_summary.json").write_text(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Codiz Automated LoRA Trainer")
    parser.add_argument("--manifest", required=True, help="Path to job_manifest.json")
    parser.add_argument("--output-dir", default="./ml_services/adapters")
    args = parser.parse_args()
    result = run_training(Path(args.manifest), Path(args.output_dir))
    print(json.dumps(result, indent=2))
