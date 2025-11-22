#!/usr/bin/env node
// ============================================================================
// UPDATE MODEL PARAMETERS
// Fetches OpenAPI schemas and updates model parameters in database
// ============================================================================

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { createClient } from '@supabase/supabase-js';
import { FalApiClient } from '../src/lib/fal/api-client';
import { parseSchemaToParameters } from '../src/lib/fal/schema-parser';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Sanitize string by removing invalid Unicode characters
 */
function sanitizeString(str: any): string | null {
  if (str === null || str === undefined) return null;
  if (typeof str !== 'string') return String(str);
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

async function updateModelParameters() {
  console.log('🚀 Starting Model Parameters Update...\n');

  try {
    // Get all models from database
    console.log('📦 Fetching models from database...');
    const { data: models, error: modelsError } = await supabase
      .from('models')
      .select('id, display_name');

    if (modelsError) {
      throw new Error(`Failed to fetch models: ${modelsError.message}`);
    }

    console.log(`✅ Found ${models.length} models\n`);

    // Initialize FAL client
    const client = new FalApiClient();

    let updated = 0;
    let failed = 0;
    let skipped = 0;

    // Process each model
    for (const model of models) {
      try {
        console.log(`\n📌 Processing: ${model.id}`);

        // Fetch OpenAPI schema
        let openapi;
        try {
          openapi = await client.fetchModelSchema(model.id);
        } catch (error: any) {
          console.warn(`  ⚠️ Schema not available, skipping`);
          skipped++;
          continue;
        }

        // Extract input schema
        const inputSchema = extractInputSchemaFromOpenAPI(openapi);

        if (!inputSchema) {
          console.warn(`  ⚠️ No input schema found, skipping`);
          skipped++;
          continue;
        }

        // Parse schema to parameters
        const parameters = parseSchemaToParameters(inputSchema);
        console.log(`  📋 Parsed ${parameters.length} parameters`);

        if (parameters.length === 0) {
          console.log(`  ℹ️  No parameters to insert`);
          skipped++;
          continue;
        }

        // Delete old parameters
        await supabase
          .from('model_parameters')
          .delete()
          .eq('model_id', model.id);

        // Insert new parameters with sanitization
        const parameterRecords = parameters.map(param => {
          const record = {
            model_id: model.id,
            parameter_name: sanitizeString(param.name),
            parameter_type: sanitizeString(param.type),
            is_required: param.required,
            default_value: param.defaultValue ? sanitizeString(String(param.defaultValue)) : null,
            min_value: param.minValue,
            max_value: param.maxValue,
            allowed_values: param.allowedValues ? sanitizeValue(param.allowedValues) : null,
            ui_label: sanitizeString(param.uiLabel),
            ui_placeholder: sanitizeString(param.uiPlaceholder),
            ui_help_text: sanitizeString(param.uiHelpText),
            ui_order: param.uiOrder,
            ui_group: sanitizeString(param.uiGroup),
          };
          // Final sanitization pass on the entire record
          return sanitizeValue(record);
        });

        const { error: paramsError } = await supabase
          .from('model_parameters')
          .insert(parameterRecords);

        if (paramsError) {
          throw paramsError;
        }

        updated++;
        console.log(`  ✅ Updated ${parameters.length} parameters`);

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error: any) {
        console.error(`  ❌ Failed: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n\n✅ Parameter update complete!`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Total: ${models.length}\n`);

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    throw error;
  }
}

updateModelParameters().catch(console.error);
