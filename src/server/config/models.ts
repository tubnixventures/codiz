export type QuantizationFormat = 'Q4_K_M' | 'Q5_K_M' | 'Q8_0' | 'AWQ' | 'BF16';

export interface FoundationModelSpec {
  id: string;
  displayName: string;
  family: string;
  parametersBillions: number;
  quantization: QuantizationFormat;
  ramRequiredGb: number;
  vramRequiredGb: number;
  diskSizeGb: number;
  contextWindow: number;
  ollamaTag: string;
  huggingfaceId: string;
  recommendedFor: string;
  loraTargetModules: string[];
  estimatedCloudRunUsdPerHour: number;
  tier: 'ultra-light' | 'primary-4b' | 'scale-7b' | 'scale-14b';
}

export const FOUNDATION_MODEL_CATALOG: FoundationModelSpec[] = [
  {
    id: 'qwen25-coder-1.5b-q4km',
    displayName: 'Codiz Feather · Qwen2.5-Coder-1.5B (Q4_K_M)',
    family: 'Qwen2.5-Coder',
    parametersBillions: 1.5,
    quantization: 'Q4_K_M',
    ramRequiredGb: 1.4,
    vramRequiredGb: 1.1,
    diskSizeGb: 1.0,
    contextWindow: 32768,
    ollamaTag: 'qwen2.5-coder:1.5b-instruct-q4_K_M',
    huggingfaceId: 'Qwen/Qwen2.5-Coder-1.5B-Instruct',
    recommendedFor:
      'CPU-only older PCs (e.g. Intel i3-2120, 8-12GB RAM, no GPU): fastest offline token speed (~6-10 tok/s).',
    loraTargetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    estimatedCloudRunUsdPerHour: 0.45,
    tier: 'ultra-light',
  },
  {
    id: 'qwen3-4b-q4km',
    displayName: 'Codiz Core · Qwen3-4B (Q4_K_M)',
    family: 'Qwen3',
    parametersBillions: 4.0,
    quantization: 'Q4_K_M',
    ramRequiredGb: 3.4,
    vramRequiredGb: 2.8,
    diskSizeGb: 2.6,
    contextWindow: 32768,
    ollamaTag: 'qwen3:4b-q4_K_M',
    huggingfaceId: 'Qwen/Qwen3-4B-Instruct',
    recommendedFor:
      'Primary balanced model for 8GB RAM laptops, low-bandwidth setups, and Cloud Run L4 scale-to-zero.',
    loraTargetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    estimatedCloudRunUsdPerHour: 0.68,
    tier: 'primary-4b',
  },
  {
    id: 'qwen25-coder-3b-q4km',
    displayName: 'Codiz Lite · Qwen2.5-Coder-3B (Q4_K_M)',
    family: 'Qwen2.5-Coder',
    parametersBillions: 3.0,
    quantization: 'Q4_K_M',
    ramRequiredGb: 2.4,
    vramRequiredGb: 2.1,
    diskSizeGb: 1.9,
    contextWindow: 32768,
    ollamaTag: 'qwen2.5-coder:3b-instruct-q4_K_M',
    huggingfaceId: 'Qwen/Qwen2.5-Coder-3B-Instruct',
    recommendedFor:
      'Ultra-low-resource CPU-only laptops (4GB–8GB RAM) and fast battery-saving offline autocomplete.',
    loraTargetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    estimatedCloudRunUsdPerHour: 0.52,
    tier: 'ultra-light',
  },
  {
    id: 'qwen3-4b-bf16',
    displayName: 'Codiz Precision · Qwen3-4B (BF16 + LoRA)',
    family: 'Qwen3',
    parametersBillions: 4.0,
    quantization: 'BF16',
    ramRequiredGb: 9.5,
    vramRequiredGb: 8.6,
    diskSizeGb: 8.1,
    contextWindow: 32768,
    ollamaTag: 'qwen3:4b-fp16',
    huggingfaceId: 'Qwen/Qwen3-4B-Instruct',
    recommendedFor:
      'QLoRA/BF16 fine-tuning base and vLLM production adapter serving on Cloud Run GPU.',
    loraTargetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    estimatedCloudRunUsdPerHour: 0.72,
    tier: 'primary-4b',
  },
  {
    id: 'qwen25-coder-7b-awq',
    displayName: 'Codiz Scale · Qwen2.5-Coder-7B (AWQ)',
    family: 'Qwen2.5-Coder',
    parametersBillions: 7.0,
    quantization: 'AWQ',
    ramRequiredGb: 6.8,
    vramRequiredGb: 5.4,
    diskSizeGb: 4.8,
    contextWindow: 32768,
    ollamaTag: 'qwen2.5-coder:7b-instruct-q4_K_M',
    huggingfaceId: 'Qwen/Qwen2.5-Coder-7B-Instruct-AWQ',
    recommendedFor: 'Optional 7B scale-up for multi-service architecture reviews when budget allows.',
    loraTargetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    estimatedCloudRunUsdPerHour: 0.85,
    tier: 'scale-7b',
  },
  {
    id: 'qwen25-coder-14b-awq',
    displayName: 'Codiz Heavy · Qwen2.5-Coder-14B (AWQ)',
    family: 'Qwen2.5-Coder',
    parametersBillions: 14.0,
    quantization: 'AWQ',
    ramRequiredGb: 12.0,
    vramRequiredGb: 9.8,
    diskSizeGb: 8.9,
    contextWindow: 32768,
    ollamaTag: 'qwen2.5-coder:14b-instruct-q4_K_M',
    huggingfaceId: 'Qwen/Qwen2.5-Coder-14B-Instruct-AWQ',
    recommendedFor: 'Future 14B upgrade path on Cloud Run L4 (24GB VRAM) without code changes.',
    loraTargetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    estimatedCloudRunUsdPerHour: 1.05,
    tier: 'scale-14b',
  },
];

export const AFRICAN_CURRENCY_RATES: Record<
  string,
  { symbol: string; name: string; perUsd: number }
> = {
  USD: { symbol: '$', name: 'US Dollar', perUsd: 1 },
  KES: { symbol: 'KSh', name: 'Kenyan Shilling', perUsd: 129.5 },
  NGN: { symbol: '₦', name: 'Nigerian Naira', perUsd: 1620 },
  ZAR: { symbol: 'R', name: 'South African Rand', perUsd: 18.1 },
  GHS: { symbol: 'GH₵', name: 'Ghanaian Cedi', perUsd: 15.8 },
  EGP: { symbol: 'E£', name: 'Egyptian Pound', perUsd: 49.5 },
  UGX: { symbol: 'USh', name: 'Ugandan Shilling', perUsd: 3680 },
  TZS: { symbol: 'TSh', name: 'Tanzanian Shilling', perUsd: 2680 },
};

export function findFoundationModel(id: string): FoundationModelSpec {
  return FOUNDATION_MODEL_CATALOG.find((m) => m.id === id) ?? FOUNDATION_MODEL_CATALOG[0];
}
