// /predictions → redirect to /predictions/current as the landing route.
import { redirect } from 'next/navigation';

export default function PredictionsIndex() {
  redirect('/predictions/current');
}
