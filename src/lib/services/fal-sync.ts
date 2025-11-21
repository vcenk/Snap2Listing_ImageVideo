// ============================================================================
// FAL MODEL SYNC SERVICE
// Fetches models from FAL AI and syncs to database
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { FalApiClient } from '../fal/api-client';
import { parseSchemaToParameters } from '../fal/schema-parser';
import type {
  FalModel,
  FalPricingItem,
  SyncResult,
  TaskType,
  PricingType,
} from '../fal/types';

function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is required in environment variables');
  }
  return url;
}

function getSupabaseServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in environment variables');
  }
  return key;
}

/**
 * Sanitize string by removing invalid Unicode characters
 */
function sanitizeString(str: string | null | undefined): string | null {
  if (!str) return null;
  // Remove unpaired surrogates (U+D800 to U+DFFF) that cause JSON errors
  return str.replace(/[\uD800-\uDFFF]/g, '');
}

/**
 * Sanitize any value recursively
 */
function sanitizeValue(value: any): any {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const sanitized: any = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(val);
    }
    return sanitized;
  }
  return value;
}

/**
 * Extract input schema from OpenAPI specification
 */
function extractInputSchemaFromOpenAPI(openapi: any): any | null {
  try {
    if (!openapi || !openapi.paths) return null;

    // Find the POST endpoint (usually the main inference endpoint)
    const paths = Object.values(openapi.paths);
    const postPath = paths.find((path: any) => path.post);

    if (!postPath || !postPath.post) return null;

    // Get request body schema
    const requestBody = postPath.post.requestBody;
    if (!requestBody || !requestBody.content) return null;

    // Get JSON schema from application/json content
    const jsonContent = requestBody.content['application/json'];
    if (!jsonContent || !jsonContent.schema) return null;

    let schema = jsonContent.schema;

    // Resolve $ref if it references components/schemas
    if (schema.$ref && openapi.components?.schemas) {
      const refName = schema.$ref.split('/').pop();
      schema = openapi.components.schemas[refName] || schema;
    }

    return schema;
  } catch (error) {
    console.warn('⚠️ Failed to extract schema from OpenAPI:', error);
    return null;
  }
}

/**
 * Detect task type from model ID
 */
function detectTaskType(modelId: string): TaskType {
  const lower = modelId.toLowerCase();

  if (lower.includes('video')) return 'VIDEO';
  if (lower.includes('audio') || lower.includes('sound') || lower.includes('music') || lower.includes('speech')) return 'AUDIO';
  if (lower.includes('text') || lower.includes('caption') || lower.includes('llm')) return 'TEXT';
  if (lower.includes('image') || lower.includes('flux') || lower.includes('stable')) return 'IMAGE';

  return 'MULTIMODAL';
}

/**
 * Get active credit rate from database
 */
async function getActiveCreditRate(supabase: any): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('credit_pricing_config')
      .select('cost_per_credit_usd')
      .eq('is_active', true)
      .single();

    if (error || !data) {
      console.warn('⚠️ No active credit config found, using default rate: $0.025');
      return 0.025;
    }

    return data.cost_per_credit_usd;
  } catch (error) {
    console.warn('⚠️ Failed to fetch credit rate, using default: $0.025');
    return 0.025;
  }
}

/**
 * Calculate credit cost from USD price
 * Uses dynamic rate from admin configuration
 */
function calculateCreditCost(priceUSD: number, creditRate: number): number {
  return Math.max(1, Math.ceil(priceUSD / creditRate));
}

/**
 * Sync FAL AI models to database
 */
export async function syncFalModels(): Promise<SyncResult> {
  const startTime = Date.now();
  const result: SyncResult = {
    modelsAdded: 0,
    modelsUpdated: 0,
    parametersAdded: 0,
    pricingUpdated: 0,
    errors: [],
    duration: 0,
  };

  console.log('🚀 Starting FAL AI model sync...\n');

  try {
    // Initialize clients
    const falClient = new FalApiClient();
    const supabase = createClient(getSupabaseUrl(), getSupabaseServiceKey());

    // Test FAL connection
    console.log('🔌 Testing FAL API connection...');
    const isConnected = await falClient.testConnection();
    if (!isConnected) {
      throw new Error('Failed to connect to FAL API');
    }
    console.log('✅ FAL API connection successful\n');

    // Get active credit rate
    console.log('💵 Fetching credit pricing configuration...');
    const creditRate = await getActiveCreditRate(supabase);
    console.log(`✅ Credit rate: $${creditRate.toFixed(4)} per credit\n`);

    // Fetch models
    console.log('📦 Fetching FAL AI models...');
    const models = await falClient.fetchModels();
    console.log(`✅ Fetched ${models.length} models\n`);

    // Fetch pricing for all models
    console.log('💰 Fetching model pricing...');
    const pricingMap = new Map<string, FalPricingItem>();

    try {
      const endpointIds = models.map(m => m.endpoint_id);
      const pricingResponse = await falClient.fetchPricing(endpointIds);

      for (const pricing of pricingResponse.prices) {
        pricingMap.set(pricing.endpoint_id, pricing);
      }
      console.log(`✅ Fetched pricing for ${pricingMap.size} models (out of ${models.length} total)\n`);

      // Debug: Show sample pricing data
      const samplePrices = Array.from(pricingMap.entries()).slice(0, 5);
      console.log('📊 Sample pricing data:');
      samplePrices.forEach(([id, price]) => {
        console.log(`   ${id}: $${price.unit_price} per ${price.unit}`);
      });

      // Show models without pricing
      const missingPricing = models.length - pricingMap.size;
      if (missingPricing > 0) {
        console.log(`\n⚠️  ${missingPricing} models don't have pricing data from FAL API`);
        console.log(`   These will be set to 1 credit (minimum cost)`);
      }
      console.log('');
    } catch (error) {
      console.warn('⚠️ Pricing endpoint failed, all models will have minimum 1 credit cost');
      console.warn(`   Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }

    // Process each model
    console.log('⚙️  Processing models...\n');

    for (const model of models) {
      try {
        // Validate model has required fields
        if (!model || !model.endpoint_id || !model.metadata) {
          console.warn(`⚠️ Skipping invalid model: missing endpoint_id or metadata`);
          result.errors.push({
            model: 'unknown',
            error: 'Model missing endpoint_id or metadata',
          });
          continue;
        }

        const fullModelId = model.endpoint_id;
        console.log(`📌 Processing: ${fullModelId}`);

        // Detect task type from category or endpoint_id
        const taskType = detectTaskType(model.metadata.category || model.endpoint_id);

        // Get pricing
        const pricing = pricingMap.get(fullModelId);
        const pricePerCall = pricing?.unit_price || 0;
        const pricingType: PricingType = pricePerCall === 0 ? 'free' : 'fixed';

        // Debug first few models
        if (result.modelsAdded + result.modelsUpdated < 5 && pricing) {
          console.log(`  🔍 Found pricing: $${pricing.unit_price} per ${pricing.unit}`);
        }

        // Calculate credit cost using dynamic rate
        const creditCost = calculateCreditCost(pricePerCall, creditRate);

        // Upsert model
        const { data: existingModel, error: checkError } = await supabase
          .from('models')
          .select('id')
          .eq('id', fullModelId)
          .single();

        // Extract input schema from OpenAPI spec
        const inputSchema = model.openapi
          ? extractInputSchemaFromOpenAPI(model.openapi)
          : null;

        const modelData = sanitizeValue({
          id: fullModelId,
          provider_id: 'fal-ai',
          name: model.endpoint_id.replace('fal-ai/', ''),
          display_name: model.metadata.display_name || model.endpoint_id.split('/').pop() || model.endpoint_id,
          description: model.metadata.description,
          task_type: taskType,
          category: model.metadata.category,
          input_schema: inputSchema || {},
          is_active: model.metadata.status === 'active',
          updated_at: new Date().toISOString(),
        });

        if (existingModel) {
          const { error: updateError } = await supabase
            .from('models')
            .update(modelData)
            .eq('id', fullModelId);

          if (updateError) throw updateError;
          result.modelsUpdated++;
          console.log(`  ✏️  Updated model`);
        } else {
          const { error: insertError } = await supabase
            .from('models')
            .insert({ ...modelData, created_at: new Date().toISOString() });

          if (insertError) throw insertError;
          result.modelsAdded++;
          console.log(`  ✨ Added new model`);
        }

        // Parse schema to parameters (if schema exists)
        const parameters = inputSchema ? parseSchemaToParameters(inputSchema) : [];
        console.log(`  📋 Parsed ${parameters.length} parameters`);

        // Delete old parameters
        await supabase
          .from('model_parameters')
          .delete()
          .eq('model_id', fullModelId);

        // Insert new parameters with sanitization
        if (parameters.length > 0) {
          const parameterRecords = parameters.map(param => sanitizeValue({
            model_id: fullModelId,
            parameter_name: param.name,
            parameter_type: param.type,
            is_required: param.required,
            default_value: param.defaultValue ? String(param.defaultValue) : null,
            min_value: param.minValue,
            max_value: param.maxValue,
            allowed_values: param.allowedValues,
            ui_label: param.uiLabel,
            ui_placeholder: param.uiPlaceholder,
            ui_help_text: param.uiHelpText,
            ui_order: param.uiOrder,
            ui_group: param.uiGroup,
          }));

          const { error: paramsError } = await supabase
            .from('model_parameters')
            .insert(parameterRecords);

          if (paramsError) throw paramsError;
          result.parametersAdded += parameters.length;
          console.log(`  ✅ Inserted ${parameters.length} parameters`);
        }

        // Upsert pricing with sanitization
        const pricingData = sanitizeValue({
          model_id: fullModelId,
          price_per_call: pricePerCall,
          min_price: null,
          max_price: null,
          pricing_type: pricingType,
          credit_cost: creditCost,
          pricing_details: pricing ? { unit: pricing.unit, currency: pricing.currency } : {},
          last_updated: new Date().toISOString(),
        });

        const { data: existingPricing } = await supabase
          .from('model_pricing')
          .select('id')
          .eq('model_id', fullModelId)
          .single();

        if (existingPricing) {
          await supabase
            .from('model_pricing')
            .update(pricingData)
            .eq('model_id', fullModelId);
        } else {
          await supabase
            .from('model_pricing')
            .insert({ ...pricingData, created_at: new Date().toISOString() });
        }

        result.pricingUpdated++;
        console.log(`  💵 Price: $${pricePerCall.toFixed(4)} = ${creditCost} credits`);
        console.log('');

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        const modelId = model?.endpoint_id || 'unknown';
        console.error(`  ❌ Error processing ${modelId}:`, errorMsg);
        result.errors.push({
          model: modelId,
          error: errorMsg,
        });
      }
    }

    result.duration = Date.now() - startTime;

    console.log('\n✅ Sync complete!\n');
    console.log('📊 Summary:');
    console.log(`  Models Added: ${result.modelsAdded}`);
    console.log(`  Models Updated: ${result.modelsUpdated}`);
    console.log(`  Parameters Added: ${result.parametersAdded}`);
    console.log(`  Pricing Records: ${result.pricingUpdated}`);
    console.log(`  Errors: ${result.errors.length}`);
    console.log(`  Duration: ${(result.duration / 1000).toFixed(2)}s\n`);

    if (result.errors.length > 0) {
      console.log('❌ Errors encountered:');
      result.errors.forEach(err => {
        console.log(`  - ${err.model}: ${err.error}`);
      });
    }

    return result;

  } catch (error) {
    console.error('\n❌ Fatal error during sync:', error);
    throw error;
  }
}

/**
 * Estimate generation cost
 */
export async function estimateGenerationCost(
  modelId: string,
  params: any
): Promise<number> {
  try {
    const falClient = new FalApiClient();
    const cost = await falClient.estimateCost(modelId, 1);
    return cost;
  } catch (error) {
    console.error('Failed to estimate cost:', error);
    return 0;
  }
}
