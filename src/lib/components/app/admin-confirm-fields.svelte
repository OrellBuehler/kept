<script lang="ts">
  import { resolve } from "$app/paths";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { fieldErrors, hasError, type FormErrors } from "$lib/form-errors";

  let {
    idPrefix,
    mode,
    errors,
    description,
  }: {
    idPrefix: string;
    mode: "password" | "totp" | "passkey";
    errors: FormErrors;
    description?: string;
  } = $props();
</script>

<Field.Field>
  <Field.Label for="{idPrefix}-adminPassword">Your password</Field.Label>
  <Input
    id="{idPrefix}-adminPassword"
    name="adminPassword"
    type="password"
    autocomplete="current-password"
    required
    aria-invalid={hasError(errors, "adminPassword")}
  />
  {#if description}<Field.Description>{description}</Field.Description>{/if}
  <Field.Error errors={fieldErrors(errors, "adminPassword")} />
</Field.Field>
{#if mode === "totp"}
  <Field.Field>
    <Field.Label for="{idPrefix}-adminCode"
      >Authenticator or recovery code</Field.Label
    >
    <Input
      id="{idPrefix}-adminCode"
      name="adminCode"
      inputmode="numeric"
      autocomplete="one-time-code"
      required
      aria-invalid={hasError(errors, "adminCode")}
    />
    <Field.Error errors={fieldErrors(errors, "adminCode")} />
  </Field.Field>
{:else if mode === "passkey"}
  <Field.Description>
    Your account uses passkeys: confirm with a passkey on the
    <a href={resolve("/settings/security")} class="underline">security page</a> first,
    then submit this form within five minutes.
  </Field.Description>
{/if}
