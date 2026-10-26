export const TUTOR_LANGUAGES = [
  { value: "en-ZA", code: "en", label: "English", locale: "en-ZA", asr: "existing" },
  { value: "af-ZA", code: "af", label: "Afrikaans", locale: "af-ZA", asr: "fluister" },
  { value: "nso-ZA", code: "nso", label: "Sepedi", locale: "nso-ZA", asr: "omnilingual" },
  { value: "st-ZA", code: "st", label: "Sesotho", locale: "st-ZA", asr: "dsfsi" },
  { value: "tn-ZA", code: "tn", label: "Setswana", locale: "tn-ZA", asr: "dsfsi" },
  { value: "ve-ZA", code: "ve", label: "Tshivenda", locale: "ve-ZA", asr: "dsfsi" },
  { value: "ts-ZA", code: "ts", label: "XiTsonga", locale: "ts-ZA", asr: "dsfsi" },
  { value: "nr-ZA", code: "nr", label: "isiNdebele", locale: "nr-ZA", asr: "dsfsi" },
  { value: "xh-ZA", code: "xh", label: "isiXhosa", locale: "xh-ZA", asr: "dsfsi" },
  { value: "zu-ZA", code: "zu", label: "isiZulu", locale: "zu-ZA", asr: "dsfsi" },
];

const LANGUAGE_BY_VALUE = new Map(TUTOR_LANGUAGES.map((language) => [language.value.toLowerCase(), language]));

export function languageForValue(value) {
  const normalized = String(value || "en-ZA").replace(/_/g, "-").toLowerCase();
  const exact = LANGUAGE_BY_VALUE.get(normalized);
  if (exact) return exact;

  const baseCode = normalized.split("-", 1)[0];
  const known = TUTOR_LANGUAGES.find((language) => language.code === baseCode && !language.disabled);
  if (known) return known;

  const displayName = (() => {
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(baseCode);
    } catch {
      return baseCode.toUpperCase();
    }
  })();
  return {
    value: normalized,
    code: baseCode,
    label: displayName || baseCode.toUpperCase(),
    locale: normalized,
    asr: "existing",
  };
}

export function supportedLocalAsrLanguage(value) {
  return languageForValue(value).asr && languageForValue(value).asr !== "existing";
}
