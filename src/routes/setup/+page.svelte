<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import AuthCard from "$lib/components/app/auth-card.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { form }: PageProps = $props();

  let pending = $state(false);
  let password = $state("");
  let confirm = $state("");
  let touchedConfirm = $state(false);

  const mismatch = $derived(touchedConfirm && confirm !== password);
</script>

<svelte:head>
  <title>Set up · Kept</title>
</svelte:head>

<AuthCard>
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-xl">Welcome to Kept</Card.Title>
      <Card.Description>
        Create the first admin account. This account will be the administrator.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        method="POST"
        class="flex flex-col gap-4"
        use:enhance={({ cancel }) => {
          touchedConfirm = true;
          if (confirm !== password) {
            cancel();
            return;
          }
          pending = true;
          return async ({ update }) => {
            await update({ reset: false });
            pending = false;
          };
        }}
      >
        <FormAlert message={formError(form?.errors)} />
        <Field.Group>
          <Field.Field>
            <Field.Label for="username">Username</Field.Label>
            <Input
              id="username"
              name="username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              required
              value={form?.values?.username ?? ""}
              aria-invalid={hasError(form?.errors, "username")}
            />
            <Field.Description>
              3 to 32 characters: letters, digits, dots, underscores, hyphens.
            </Field.Description>
            <Field.Error errors={fieldErrors(form?.errors, "username")} />
          </Field.Field>
          <Field.Field>
            <Field.Label for="displayName">
              Display name <span class="text-muted-foreground">(optional)</span>
            </Field.Label>
            <Input
              id="displayName"
              name="displayName"
              autocomplete="name"
              value={form?.values?.displayName ?? ""}
              aria-invalid={hasError(form?.errors, "displayName")}
            />
            <Field.Error errors={fieldErrors(form?.errors, "displayName")} />
          </Field.Field>
          <Field.Field>
            <Field.Label for="password">Password</Field.Label>
            <Input
              id="password"
              name="password"
              type="password"
              autocomplete="new-password"
              required
              minlength={10}
              bind:value={password}
              aria-invalid={hasError(form?.errors, "password")}
            />
            <Field.Description>At least 10 characters.</Field.Description>
            <Field.Error errors={fieldErrors(form?.errors, "password")} />
          </Field.Field>
          <Field.Field>
            <Field.Label for="confirm">Confirm password</Field.Label>
            <Input
              id="confirm"
              type="password"
              autocomplete="new-password"
              required
              bind:value={confirm}
              onblur={() => (touchedConfirm = confirm.length > 0)}
              aria-invalid={mismatch}
            />
            {#if mismatch}
              <Field.Error>Passwords do not match.</Field.Error>
            {/if}
          </Field.Field>
        </Field.Group>
        <Button type="submit" disabled={pending} class="w-full">
          {#if pending}<Spinner />Creating account…{:else}Create admin account{/if}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</AuthCard>
