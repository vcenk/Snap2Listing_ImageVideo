#!/usr/bin/env node
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function checkCounts() {
  console.log('🔍 Checking Supabase record counts...\n');

  // Check model_parameters count
  const { count: paramsCount, error: paramsError } = await supabase
    .from('model_parameters')
    .select('*', { count: 'exact', head: true });

  if (paramsError) {
    console.error('❌ Error fetching model_parameters count:', paramsError);
  } else {
    console.log(`📋 Total model_parameters records: ${paramsCount}`);
  }

  // Check models count
  const { count: modelsCount, error: modelsError } = await supabase
    .from('models')
    .select('*', { count: 'exact', head: true });

  if (modelsError) {
    console.error('❌ Error fetching models count:', modelsError);
  } else {
    console.log(`📦 Total models: ${modelsCount}`);
  }

  // Get sample of recently updated parameters
  const { data: recentParams, error: recentError } = await supabase
    .from('model_parameters')
    .select('model_id, parameter_name, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (recentError) {
    console.error('❌ Error fetching recent parameters:', recentError);
  } else {
    console.log('\n📅 Most recent parameter records:');
    recentParams?.forEach(param => {
      console.log(`   ${param.model_id} - ${param.parameter_name} (${param.created_at})`);
    });
  }

  // Count parameters by model
  const { data: paramsByModel, error: countError } = await supabase
    .rpc('count_parameters_by_model')
    .limit(10);

  // If RPC doesn't exist, do manual count
  const { data: modelsWithParams } = await supabase
    .from('models')
    .select('id, display_name')
    .limit(5);

  if (modelsWithParams) {
    console.log('\n🔢 Sample models and their parameter counts:');
    for (const model of modelsWithParams) {
      const { count } = await supabase
        .from('model_parameters')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', model.id);
      console.log(`   ${model.id}: ${count} parameters`);
    }
  }
}

checkCounts().catch(console.error);
