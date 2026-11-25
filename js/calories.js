// Keytel 2005: gasto calórico por minuto a partir de la frecuencia cardiaca.

export function caloriesPerMinute(hr, weightKg, age, isMale) {
  if (!weightKg || !age) return 0;
  const raw = isMale
    ? (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184
    : (-20.4022 + 0.4472 * hr + 0.1263 * weightKg + 0.074 * age) / 4.184;
  return raw > 0 ? raw : 0;
}
