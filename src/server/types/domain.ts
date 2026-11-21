export type AgentMode =
  | 'chat'
  | 'completion'
  | 'debugging'
  | 'architecture'
  | 'review'
  | 'autonomous';

export type ModelDeploymentStatus =
  | 'draft'
  | 'training'
  | 'candidate'
  | 'production'
  | 'archived'
  | 'rolled_back';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface LoraConfig {
  rank: number;
  alpha: number;
  dropout: number;
  learningRate: number;
  epochs: number;
  batchSize: number;
  quantizationBits: 4 | 8 | 16;
  targetModules: string[];
}

export interface EvalMetrics {
  overallScore: number;
  typecheckPassRate: number;
  securityPassRate: number;
  unitTestPassRate: number;
  apiAccuracyScore: number;
  avgLatencyMs: number;
  evaluatedAt: string;
  checksRun: number;
  notes: string;
}

export interface ModelVersionRecord {
  id: string;
  versionTag: string;
  foundationModelId: string;
  foundationModelName: string;
  adapterVersion: string;
  adapterUri: string;
  datasetVersion: string;
  loraConfig: LoraConfig;
  trainingDate: string;
  validationLoss: number | null;
  evalMetrics: EvalMetrics | null;
  approvalStatus: ApprovalStatus;
  deploymentStatus: ModelDeploymentStatus;
  previousProductionId: string | null;
  sha256: string;
}

export type DatasetStage = 'raw' | 'cleaned' | 'approved' | 'validation';

export interface TrainingExampleRecord {
  id: string;
  datasetVersion: string;
  stage: DatasetStage;
  category: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  source: 'interaction' | 'teacher-synthetic' | 'muse-code-import' | 'manual';
  licenseMetadata: string;
  attribution: string;
  prompt: string;
  completion: string;
  systemContext: string;
  secretsScrubbed: boolean;
  teacherScore: number | null;
  automatedChecksPassed: boolean;
  contentHash: string;
  createdAt: string;
}

export interface BudgetSnapshot {
  monthKey: string;
  monthlyBudgetUsd: number;
  totalSpentUsd: number;
  percentUsed: number;
  thresholdState: 'nominal' | 'notify_50' | 'warn_75' | 'restrict_90' | 'paused_100';
  breakdown: {
    teacherApiUsd: number;
    cloudRunGpuUsd: number;
    gcsStorageUsd: number;
    embeddingsUsd: number;
  };
  localSavingsUsd: number;
  dailyTeacherCalls: number;
  maxDailyTeacherCalls: number;
  advisoryNotice: string;
}
