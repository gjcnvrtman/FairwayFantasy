// /predictions/weights — list + create + activate model weight configs.

import { db } from '@/lib/db';
import WeightsClient from './WeightsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Model Weights — Predictions' };

interface ConfigRow {
  id: string;
  name: string;
  description: string | null;
  course_fit_weight: string;
  recent_form_weight: string;
  long_term_weight: string;
  course_history_weight: string;
  cut_probability_weight: string;
  upside_weight: string;
  is_active: boolean;
  created_at: string;
}

async function loadConfigs(): Promise<ConfigRow[]> {
  return await db.selectFrom('model_weight_configs')
    .selectAll()
    .orderBy('is_active', 'desc')
    .orderBy('created_at', 'desc')
    .execute();
}

export default async function WeightsPage() {
  const configs = await loadConfigs();
  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ marginTop: 0 }}>Model weight configs</h1>
      <p style={{ color: '#666' }}>
        Each config sets the six subscore weights for the composite
        score. Exactly one is <strong>active</strong> at a time — that&apos;s
        the one new prediction runs use. Edit weights, activate a
        different one, or A/B by running the predictor with different
        actives and comparing.
      </p>

      <WeightsClient configs={configs} />
    </div>
  );
}
