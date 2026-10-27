export const TUTOR_LANGUAGES = [
  { value: "en-ZA", code: "en", label: "English", locale: "en-ZA" },
];

const ENGLISH = TUTOR_LANGUAGES[0];

export function languageForValue(_value) {
  return ENGLISH;
}
