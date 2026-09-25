import type { AppConfig, ProviderConfig, RouteRule } from "../config/config";
import type { CredentialPool } from "../oauth/credentialPool";
import type { ModelInfo } from "../translate/models";
import { MODEL_CATALOG } from "../translate/models";
import type { Provider } from "../providers/types";
import { GoogleOAuthProvider } from "../providers/googleOAuthProvider";
import { AnthropicProvider } from "../providers/anthropicProvider";
import { OpenAiProvider } from "../providers/openAiProvider";
import { CodexOAuthProvider } from "../providers/codexOAuthProvider";

export interface ResolvedRoute {
  provider: Provider;
  targetModel: string;
}

export interface DispatcherOptions {
  config: AppConfig;
  pool?: CredentialPool;
  fetch?: typeof fetch;
}

export class Dispatcher {
  private config: AppConfig;
  private providers: Map<string, Provider> = new Map();
  private routes: RouteRule[];

  constructor(options: DispatcherOptions) {
    this.config = options.config;
    this.routes = options.config.routes || [];

    const rawProviders = options.config.providers || {};
    if (Object.keys(rawProviders).length === 0) {
      // Default to google-oauth for backward compatibility
      const googleProvider = new GoogleOAuthProvider({
        id: "antigravity-oauth",
        pool: options.pool,
        fetch: options.fetch
      });
      this.providers.set("antigravity-oauth", googleProvider);
    } else {
      for (const [id, pConfig] of Object.entries(rawProviders)) {
        const provider = this.createProvider(id, pConfig, options.pool, options.fetch);
        if (provider) {
          this.providers.set(id, provider);
        }
      }
    }
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  listProviders(): Provider[] {
    return Array.from(this.providers.values());
  }

  async getAggregatedModels(): Promise<ModelInfo[]> {
    const list: ModelInfo[] = [];
    const seen = new Set<string>();

    for (const provider of this.providers.values()) {
      try {
        const pModels = await provider.getModels();
        for (const m of pModels) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            list.push(m);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[dispatcher] failed to get models from provider '${provider.id}': ${message}`);
      }
    }

    // Add models matched in route rules if not present
    for (const rule of this.routes) {
      if (typeof rule.match === "string" && !seen.has(rule.match)) {
        seen.add(rule.match);
        list.push({
          id: rule.match,
          display_name: rule.match,
          context_length: 200_000,
          max_completion_tokens: 8_192
        });
      } else if (Array.isArray(rule.match)) {
        for (const m of rule.match) {
          if (!seen.has(m)) {
            seen.add(m);
            list.push({
              id: m,
              display_name: m,
              context_length: 200_000,
              max_completion_tokens: 8_192
            });
          }
        }
      }
    }

    // Fallback if empty and google-oauth is present
    if (list.length === 0 && this.hasGoogleOAuth()) {
      return MODEL_CATALOG.filter((m) => !this.config.disabledModels?.includes(m.id));
    }

    return list.filter((m) => !this.config.disabledModels?.includes(m.id));
  }

  async resolveRoute(requestedModel: string): Promise<ResolvedRoute | undefined> {
    if (this.config.disabledModels?.includes(requestedModel)) return undefined;
    if (!requestedModel) return undefined;

    // 1. Explicit route matching
    for (const rule of this.routes) {
      const provider = this.providers.get(rule.provider);
      if (!provider) continue;

      if (typeof rule.match === "string" && rule.match === requestedModel) {
        return {
          provider,
          targetModel: rule.targetModel || requestedModel
        };
      }

      if (Array.isArray(rule.match) && rule.match.includes(requestedModel)) {
        return {
          provider,
          targetModel: rule.targetModel || requestedModel
        };
      }

      if (rule.modelPrefix && requestedModel.startsWith(rule.modelPrefix)) {
        const stripped = rule.stripPrefix
          ? requestedModel.slice(rule.modelPrefix.length)
          : requestedModel;
        return {
          provider,
          targetModel: rule.targetModel || stripped
        };
      }
    }

    // 2. Check each provider's static & dynamic models
    for (const [id, provider] of this.providers.entries()) {
      const pConfig = this.config.providers?.[id];
      if (pConfig?.models?.includes(requestedModel)) {
        return { provider, targetModel: requestedModel };
      }
    }

    // 3. Antigravity / Gemini model catalog matching
    const isGeminiCatalog = MODEL_CATALOG.some((m) => m.id === requestedModel) || requestedModel.startsWith("gemini-");
    if (isGeminiCatalog) {
      for (const provider of this.providers.values()) {
        if (provider.type === "google-oauth") {
          return { provider, targetModel: requestedModel };
        }
      }
    }

    for (const provider of this.providers.values()) {
      try {
        const models = await provider.getModels();
        if (models.some((m) => m.id === requestedModel)) {
          return { provider, targetModel: requestedModel };
        }
      } catch {
        // continue
      }
    }

    // 4. If only one provider exists, use it
    if (this.providers.size === 1) {
      const soleProvider = Array.from(this.providers.values())[0];
      return { provider: soleProvider, targetModel: requestedModel };
    }

    // Unresolved models are reported to the caller as a routing failure. Never
    // forward them to an arbitrary provider: the upstream then rejects a model
    // it was never meant to serve, and its error message points at the wrong
    // provider instead of at the missing route.
    return undefined;
  }

  private hasGoogleOAuth(): boolean {
    for (const p of this.providers.values()) {
      if (p.type === "google-oauth") return true;
    }
    return false;
  }

  private createProvider(
    id: string,
    pConfig: ProviderConfig,
    pool?: CredentialPool,
    fetchImpl?: typeof fetch
  ): Provider | undefined {
    switch (pConfig.type) {
      case "google-oauth":
        return new GoogleOAuthProvider({
          id,
          pool,
          configuredModels: pConfig.models,
          fetch: fetchImpl
        });
      case "anthropic":
        return new AnthropicProvider({
          id,
          baseUrl: pConfig.baseUrl,
          apiKey: pConfig.apiKey,
          apiKeyFile: pConfig.apiKeyFile,
          apiKeySettingsFile: pConfig.apiKeySettingsFile,
          headers: pConfig.headers,
          models: pConfig.models,
          autoDiscoverModels: pConfig.autoDiscoverModels,
          modelRefreshIntervalMs: pConfig.modelRefreshIntervalMs,
          geminiSchemaConstraints: pConfig.geminiSchemaConstraints,
          fetch: fetchImpl
        });
      case "openai":
        return new OpenAiProvider({
          id,
          baseUrl: pConfig.baseUrl,
          apiKey: pConfig.apiKey,
          headers: pConfig.headers,
          models: pConfig.models,
          autoDiscoverModels: pConfig.autoDiscoverModels,
          modelRefreshIntervalMs: pConfig.modelRefreshIntervalMs,
          fetch: fetchImpl
        });
      case "codex-oauth":
        if (!pConfig.authFile) return undefined;
        return new CodexOAuthProvider({
          id,
          authFile: pConfig.authFile,
          baseUrl: pConfig.baseUrl,
          headers: pConfig.headers,
          models: pConfig.models,
          autoDiscoverModels: pConfig.autoDiscoverModels,
          modelRefreshIntervalMs: pConfig.modelRefreshIntervalMs,
          clientVersion: pConfig.clientVersion,
          originator: pConfig.originator,
          fetch: fetchImpl
        });
      default:
        return undefined;
    }
  }
}
