export type FormErrors = Record<string, string[]> | undefined;

export function fieldErrors(errors: FormErrors, name: string) {
  return errors?.[name]?.map((message) => ({ message }));
}

export function formError(errors: FormErrors) {
  return errors?.form?.[0];
}

export function hasError(errors: FormErrors, name: string) {
  return !!errors?.[name]?.length;
}
