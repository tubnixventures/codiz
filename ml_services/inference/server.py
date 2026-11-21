"""Codiz Python Inference Service — OpenAI-compatible & dynamic LoRA adapter serving."""

from __future__ import annotations

import os
import time
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

MODEL_ID: str = os.getenv("CODIZ_FOUNDATION_MODEL", "Qwen/Qwen3-4B-Instruct")
ADAPTER_PATH: str = os.getenv("CODIZ_ACTIVE_ADAPTER_PATH", "")
RUNTIME_BACKEND: str = os.getenv("CODIZ_ML_BACKEND", "transformers")  # vllm | transformers | llama_cpp
QUANTIZATION: str = os.getenv("CODIZ_QUANTIZATION", "4bit")

app = FastAPI(title="Codiz ML Inference Service", version="1.0.0")

_loaded_engine: dict[str, Any] = {
    "backend": RUNTIME_BACKEND,
    "model_id": MODEL_ID,
    "adapter_path": ADAPTER_PATH,
    "ready": False,
    "model": None,
    "tokenizer": None,
}


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = Field(default=MODEL_ID)
    messages: list[ChatMessage]
    max_tokens: int = Field(default=1024, ge=1, le=8192)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


class AdapterSwitchRequest(BaseModel):
    adapter_path: str
    adapter_version: str


def _ensure_loaded() -> None:
    if _loaded_engine["ready"]:
        return

    if RUNTIME_BACKEND == "llama_cpp":
        from llama_cpp import Llama  # type: ignore

        gguf_path = os.getenv("CODIZ_GGUF_PATH", "/models/qwen3-4b-q4_k_m.gguf")
        _loaded_engine["model"] = Llama(
            model_path=gguf_path,
            n_ctx=int(os.getenv("CODIZ_CTX_SIZE", "8192")),
            n_threads=int(os.getenv("CODIZ_THREADS", "4")),
        )
        _loaded_engine["ready"] = True
        return

    if RUNTIME_BACKEND == "vllm":
        from vllm import LLM  # type: ignore

        _loaded_engine["model"] = LLM(
            model=MODEL_ID,
            quantization="awq" if "awq" in MODEL_ID.lower() else None,
            max_model_len=8192,
            gpu_memory_utilization=0.88,
            enable_lora=True,
        )
        _loaded_engine["ready"] = True
        return

    # Default: Transformers + optional 4-bit NF4 + PEFT LoRA adapter
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=False)
    kwargs: dict[str, Any] = {"device_map": "auto"}
    if QUANTIZATION == "4bit" and torch.cuda.is_available():
        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
    else:
        kwargs["torch_dtype"] = torch.bfloat16 if torch.cuda.is_available() else torch.float32

    base_model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **kwargs)
    if _loaded_engine["adapter_path"]:
        from peft import PeftModel

        base_model = PeftModel.from_pretrained(base_model, _loaded_engine["adapter_path"])

    _loaded_engine["model"] = base_model
    _loaded_engine["tokenizer"] = tokenizer
    _loaded_engine["ready"] = True


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "backend": _loaded_engine["backend"],
        "model_id": _loaded_engine["model_id"],
        "adapter_path": _loaded_engine["adapter_path"] or "base",
        "ready": _loaded_engine["ready"],
    }


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": _loaded_engine["model_id"],
                "object": "model",
                "owned_by": "codiz",
                "adapter": _loaded_engine["adapter_path"] or "base",
            }
        ],
    }


@app.post("/v1/adapters/load")
def load_adapter(req: AdapterSwitchRequest) -> dict[str, Any]:
    if not os.path.exists(req.adapter_path):
        raise HTTPException(status_code=404, detail="Adapter directory not found")
    _loaded_engine["adapter_path"] = req.adapter_path
    _loaded_engine["ready"] = False
    _ensure_loaded()
    return {"status": "loaded", "adapter_version": req.adapter_version}


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest) -> dict[str, Any]:
    _ensure_loaded()
    started = time.time()

    if RUNTIME_BACKEND == "llama_cpp":
        llm = _loaded_engine["model"]
        out = llm.create_chat_completion(
            messages=[m.model_dump() for m in req.messages],
            max_tokens=req.max_tokens,
            temperature=req.temperature,
        )
        return out

    if RUNTIME_BACKEND == "vllm":
        from vllm import SamplingParams  # type: ignore

        llm = _loaded_engine["model"]
        prompt = "\n".join(f"{m.role}: {m.content}" for m in req.messages) + "\nassistant:"
        params = SamplingParams(temperature=req.temperature, max_tokens=req.max_tokens)
        outputs = llm.generate([prompt], params)
        text = outputs[0].outputs[0].text
        return {
            "id": f"cdz-{int(started)}",
            "object": "chat.completion",
            "model": req.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        }

    import torch

    tokenizer = _loaded_engine["tokenizer"]
    model = _loaded_engine["model"]
    formatted = tokenizer.apply_chat_template(
        [m.model_dump() for m in req.messages],
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(formatted, return_tensors="pt").to(model.device)
    with torch.no_grad():
        generated = model.generate(
            **inputs,
            max_new_tokens=req.max_tokens,
            temperature=max(req.temperature, 0.01),
            do_sample=req.temperature > 0,
        )
    reply_tokens = generated[0][inputs["input_ids"].shape[-1] :]
    text = tokenizer.decode(reply_tokens, skip_special_tokens=True)

    return {
        "id": f"cdz-{int(started)}",
        "object": "chat.completion",
        "model": req.model,
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
        "usage": {
            "prompt_tokens": int(inputs["input_ids"].shape[-1]),
            "completion_tokens": int(len(reply_tokens)),
        },
    }
