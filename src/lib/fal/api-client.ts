// ============================================================================
// FAL AI API CLIENT
// ============================================================================

import {
  FalModel,
  FalPricingResponse,
  FalEstimateRequest,
  FalEstimateResponse,
  FalApiError,
} from './types';

export class FalApiClient {
  private apiKey: string;
  private baseUrl: string = 'https://api.fal.ai';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.FAL_KEY || '';

    if (!this.apiKey) {
      throw new Error('FAL_KEY is required. Set it in environment variables or pass to constructor.');
    }
  }

  /**
   * Make authenticated request to FAL API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const headers = {
      'Authorization': `Key ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    console.log(`📡 FAL API Request: ${options.method || 'GET'} ${url}`);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData: FalApiError;

        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = {
            code: `HTTP_${response.status}`,
            message: errorText || response.statusText,
          };
        }

        console.error(`❌ FAL API Error Details:`, {
          status: response.status,
          url,
          error: errorData,
        });

        throw new Error(
          `FAL API Error (${response.status}): ${errorData.message || errorData.code}`
        );
      }

      const data = await response.json();
      console.log(`✅ FAL API Response received`);
      return data as T;

    } catch (error) {
      console.error('❌ FAL API Request failed:', error);
      throw error;
    }
  }

  /**
   * Fetch all available models from FAL AI
   * GET /v1/models
   */
  async fetchModels(includeSchemas: boolean = true): Promise<FalModel[]> {
    console.log(`🔍 Fetching all FAL AI models${includeSchemas ? ' with schemas' : ''}...`);

    try {
      const allModels: FalModel[] = [];
      let cursor: string | null = null;
      let pageCount = 0;

      do {
        pageCount++;
        const params = new URLSearchParams({
          limit: '100',
        });

        // Try to include OpenAPI schemas if requested
        if (includeSchemas) {
          params.append('expand', 'openapi-3.0');
        }

        if (cursor) {
          params.append('cursor', cursor);
        }

        const url = `/v1/models?${params.toString()}`;

        try {
          const response = await this.request<{
            models: FalModel[];
            next_cursor: string | null;
            has_more: boolean;
          }>(url);

          if (response.models && Array.isArray(response.models)) {
            allModels.push(...response.models);
            console.log(`  📄 Page ${pageCount}: Fetched ${response.models.length} models (total: ${allModels.length})`);
          }

          cursor = response.has_more ? response.next_cursor : null;

        } catch (pageError) {
          // If expand parameter fails, retry without it
          if (includeSchemas && pageError instanceof Error && pageError.message.includes('400')) {
            console.warn('⚠️ OpenAPI expand not supported, retrying without schemas...');
            return this.fetchModels(false);
          }
          throw pageError;
        }

      } while (cursor);

      console.log(`✅ Fetched ${allModels.length} models across ${pageCount} pages`);

      // Debug: log first model structure
      if (allModels.length > 0) {
        console.log('🔍 First model has OpenAPI:', !!allModels[0].openapi);
      }

      return allModels;
    } catch (error) {
      console.error('❌ Failed to fetch models:', error);
      throw new Error(`Failed to fetch models: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Sleep utility for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Sanitize string by removing invalid Unicode characters
   */
  private sanitizeString(str: string): string {
    // Remove unpaired surrogates (U+D800 to U+DFFF)
    // These cause JSON serialization errors
    return str.replace(/[\uD800-\uDFFF]/g, '');
  }

  /**
   * Recursively sanitize an object, removing invalid Unicode from all strings
   */
  private sanitizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return this.sanitizeString(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    if (obj !== null && typeof obj === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        sanitized[key] = this.sanitizeObject(value);
      }
      return sanitized;
    }

    return obj;
  }

  /**
   * Sanitize pricing response to remove invalid Unicode characters
   */
  private sanitizePricingResponse(response: FalPricingResponse): FalPricingResponse {
    return {
      ...response,
      prices: response.prices.map(price => ({
        ...price,
        endpoint_id: this.sanitizeString(price.endpoint_id),
        unit: typeof price.unit === 'string' ? this.sanitizeString(price.unit) : price.unit,
        currency: typeof price.currency === 'string' ? this.sanitizeString(price.currency) : price.currency,
      })),
    };
  }

  /**
   * Fetch pricing data for all models with rate limiting
   * GET /v1/models/pricing
   */
  async fetchPricing(endpointIds: string[]): Promise<FalPricingResponse> {
    console.log(`💰 Fetching pricing for ${endpointIds.length} models...`);

    try {
      const allPrices: FalPricingItem[] = [];

      // API accepts max 50 endpoint_ids at once
      const batchSize = 50;
      const totalBatches = Math.ceil(endpointIds.length / batchSize);

      for (let i = 0; i < endpointIds.length; i += batchSize) {
        const batchNumber = Math.floor(i / batchSize) + 1;
        const batch = endpointIds.slice(i, i + batchSize);

        const params = new URLSearchParams();
        batch.forEach(id => params.append('endpoint_id', id));

        // Retry logic with exponential backoff
        let retries = 0;
        const maxRetries = 3;
        let success = false;

        while (retries <= maxRetries && !success) {
          try {
            const response = await this.request<FalPricingResponse>(
              `/v1/models/pricing?${params.toString()}`
            );

            if (response.prices && Array.isArray(response.prices)) {
              const sanitized = this.sanitizePricingResponse(response);
              allPrices.push(...sanitized.prices);
              console.log(`  💵 Batch ${batchNumber}/${totalBatches}: Fetched ${response.prices.length} prices`);
              success = true;
            }
          } catch (error: any) {
            // Check if rate limit error (429)
            if (error.message?.includes('429') || error.message?.includes('Rate limit')) {
              retries++;
              if (retries <= maxRetries) {
                const waitTime = Math.pow(2, retries) * 1000; // Exponential backoff: 2s, 4s, 8s
                console.log(`  ⏳ Rate limit hit. Waiting ${waitTime / 1000}s before retry ${retries}/${maxRetries}...`);
                await this.sleep(waitTime);
              } else {
                throw error; // Max retries exceeded
              }
            } else if (error.message?.includes('404') || error.message?.includes('not found')) {
              // Some endpoints no longer exist, skip this batch
              console.warn(`  ⚠️ Batch ${batchNumber}/${totalBatches}: Some endpoints not found, skipping batch`);
              success = true; // Mark as success to continue to next batch
            } else {
              throw error; // Different error, don't retry
            }
          }
        }

        // Add delay between batches to avoid rate limiting (except for last batch)
        if (i + batchSize < endpointIds.length) {
          await this.sleep(5000); // 5s delay between batches to respect strict rate limits
        }
      }

      console.log(`✅ Fetched pricing for ${allPrices.length} models`);

      return {
        prices: allPrices,
        next_cursor: null,
        has_more: false,
      };
    } catch (error) {
      console.error('❌ Failed to fetch pricing:', error);
      throw new Error(`Failed to fetch pricing: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Estimate cost for a single model
   * POST /v1/models/pricing/estimate
   */
  async estimateCost(modelId: string, callQuantity: number = 1): Promise<number> {
    console.log(`📊 Estimating cost for ${modelId} (${callQuantity} calls)...`);

    try {
      const request: FalEstimateRequest = {
        estimate_type: 'historical_api_price',
        endpoints: {
          [modelId]: { call_quantity: callQuantity },
        },
      };

      const response = await this.request<FalEstimateResponse>(
        '/v1/models/pricing/estimate',
        {
          method: 'POST',
          body: JSON.stringify(request),
        }
      );

      const estimate = response.estimates[modelId];
      if (!estimate) {
        console.warn(`⚠️ No estimate found for ${modelId}`);
        return 0;
      }

      const costPerCall = estimate.cost_per_call;
      console.log(`✅ Estimated cost: $${costPerCall.toFixed(4)} per call`);
      return costPerCall;

    } catch (error) {
      console.error('❌ Failed to estimate cost:', error);
      // Return 0 instead of throwing to allow sync to continue
      return 0;
    }
  }

  /**
   * Estimate costs for multiple models in batch
   * POST /v1/models/pricing/estimate
   */
  async estimateBatch(models: Record<string, number>): Promise<FalEstimateResponse> {
    console.log(`📊 Batch estimating costs for ${Object.keys(models).length} models...`);

    try {
      const endpoints: Record<string, { call_quantity: number }> = {};

      for (const [modelId, quantity] of Object.entries(models)) {
        endpoints[modelId] = { call_quantity: quantity };
      }

      const request: FalEstimateRequest = {
        estimate_type: 'historical_api_price',
        endpoints,
      };

      const response = await this.request<FalEstimateResponse>(
        '/v1/models/pricing/estimate',
        {
          method: 'POST',
          body: JSON.stringify(request),
        }
      );

      console.log(`✅ Batch estimate complete for ${Object.keys(response.estimates).length} models`);
      return response;

    } catch (error) {
      console.error('❌ Failed to batch estimate:', error);
      throw new Error(`Failed to batch estimate: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch OpenAPI schema for a specific model
   * GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id={model_id}
   */
  async fetchModelSchema(endpointId: string): Promise<any> {
    console.log(`📋 Fetching schema for ${endpointId}...`);

    try {
      const url = `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpointId)}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Key ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
      }

      const schema = await response.json();
      // Sanitize schema to remove invalid Unicode characters
      const sanitizedSchema = this.sanitizeObject(schema);
      console.log(`✅ Schema fetched and sanitized for ${endpointId}`);
      return sanitizedSchema;

    } catch (error) {
      console.error(`❌ Failed to fetch schema for ${endpointId}:`, error);
      throw error;
    }
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<boolean> {
    console.log('🔌 Testing FAL API connection...');

    try {
      await this.fetchModels();
      console.log('✅ FAL API connection successful');
      return true;
    } catch (error) {
      console.error('❌ FAL API connection failed:', error);
      return false;
    }
  }
}

/**
 * Singleton instance
 */
let clientInstance: FalApiClient | null = null;

/**
 * Get FAL API client instance
 */
export function getFalClient(apiKey?: string): FalApiClient {
  if (!clientInstance) {
    clientInstance = new FalApiClient(apiKey);
  }
  return clientInstance;
}
