import type { FeatureExtractionPipeline } from "../services/embeddings.ts";

export interface PipelineCall {
  task: string;
  model: string;
  options: { dtype: string };
}

export interface RecordingPipeline {
  readonly pipeline: FeatureExtractionPipeline;
  readonly calls: readonly PipelineCall[];
  setImplementation(impl: FeatureExtractionPipeline): void;
}

export function createRecordingPipeline(initialImpl: FeatureExtractionPipeline): RecordingPipeline {
  const calls: PipelineCall[] = [];
  let implementation = initialImpl;

  const pipeline: FeatureExtractionPipeline = (task, model, options) => {
    calls.push({ task, model, options });
    return implementation(task, model, options);
  };

  return {
    pipeline,
    calls,
    setImplementation(impl) {
      implementation = impl;
    },
  };
}
