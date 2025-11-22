#!/usr/bin/env node
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

function sanitizeString(str: any): string | null {
  if (str === null || str === undefined) return null;
  if (typeof str !== 'string') return String(str);
  return str.replace(/[\uD800-\uDFFF]/g, '');
}

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

function extractInputSchemaFromOpenAPI(openapi: any): any | null {
  try {
    if (!openapi || !openapi.paths) return null;

    const paths = Object.values(openapi.paths);
    const postPath = paths.find((path: any) => path.post);

    if (!postPath || !postPath.post) return null;

    const requestBody = postPath.post.requestBody;
    if (!requestBody || !requestBody.content) return null;

    const jsonContent = requestBody.content['application/json'];
    if (!jsonContent || !jsonContent.schema) return null;

    let schema = jsonContent.schema;

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

async function testInsert() {
  console.log('🧪 Testing parameter insert for one model...\n');

  const testModelId = 'fal-ai/flux/dev';

  try {
    // Initialize FAL client
    const client = new FalApiClient();

    console.log(`📌 Testing with model: ${testModelId}`);

    // Fetch OpenAPI schema
    const openapi = await client.fetchModelSchema(testModelId);

    // Extract input schema
    const inputSchema = extractInputSchemaFromOpenAPI(openapi);

    if (!inputSchema) {
      console.error('❌ No input schema found');
      return;
    }

    console.log('📋 Input schema found:', JSON.stringify(inputSchema, null, 2).substring(0, 500) + '...');

    // Parse schema to parameters
    const parameters = parseSchemaToParameters(inputSchema);
    console.log(`\n✅ Parsed ${parameters.length} parameters`);

    if (parameters.length > 0) {
      console.log('\n📝 First parameter:', JSON.stringify(parameters[0], null, 2));
    }

    // Prepare records with sanitization
    const parameterRecords = parameters.map(param => {
      const record = {
        model_id: testModelId,
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
      return sanitizeValue(record);
    });

    console.log('\n📦 First record to insert:', JSON.stringify(parameterRecords[0], null, 2));

    // Delete old parameters
    console.log(`\n🗑️  Deleting old parameters for ${testModelId}...`);
    const { error: deleteError } = await supabase
      .from('model_parameters')
      .delete()
      .eq('model_id', testModelId);

    if (deleteError) {
      console.error('❌ Delete error:', deleteError);
    } else {
      console.log('✅ Old parameters deleted');
    }

    // Insert new parameters
    console.log(`\n💾 Inserting ${parameterRecords.length} new parameters...`);
    const { data, error: insertError } = await supabase
      .from('model_parameters')
      .insert(parameterRecords)
      .select();

    if (insertError) {
      console.error('❌ Insert error:', insertError);
      console.error('Error details:', JSON.stringify(insertError, null, 2));
    } else {
      console.log(`✅ Successfully inserted ${data?.length} parameters`);
      console.log('First inserted record:', data?.[0]);
    }

    // Verify
    const { count } = await supabase
      .from('model_parameters')
      .select('*', { count: 'exact', head: true })
      .eq('model_id', testModelId);

    console.log(`\n🔍 Verification: ${count} parameters now exist for ${testModelId}`);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
}

testInsert().catch(console.error);
