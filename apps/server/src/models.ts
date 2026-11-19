import type { CreateModelsOptions, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * pi-ai's built-in models, plus GPT-6.2 Sol (the default model) on OpenAI while pi-ai's catalog doesn't list it yet.
 * models.dev and pi's next catalog give it GPT-6.1 Sol's limits, prices, thinking levels and API features, so it is
 * that entry under the new id. Once pi-ai ships it, its own entry is used.
 */
export const topModels = (options?: CreateModelsOptions): MutableModels => {
  const models = builtinModels(options);
  const openai = models.getProvider("openai");
  const sol = models.getModel("openai", "gpt-6.1-sol");
  if (!openai || !sol || models.getModel("openai", "gpt-6.2-sol")) return models;
  const added = { ...sol, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" };
  models.setProvider({
    ...openai,
    getModels: () => [...openai.getModels(), added],
    getAllModels: () => [...(openai.getAllModels?.() ?? openai.getModels()), added],
  });
  return models;
};
