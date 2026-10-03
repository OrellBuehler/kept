<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { startAuthentication } from "@simplewebauthn/browser";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import AuthCard from "$lib/components/app/auth-card.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let pending = $state(false);
  let passkeyBusy = $state(false);
  let passkeyError = $state<string | undefined>();
  const passkeysSupported =
    typeof window !== "undefined" && !!window.PublicKeyCredential;

  async function signInWithPasskey() {
    passkeyError = undefined;
    passkeyBusy = true;
    try {
      const headers = { "content-type": "application/json" };
      const optRes = await fetch("/api/auth/passkey/login/options", {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "passwordless" }),
      });
      if (!optRes.ok) throw new Error("Could not start passkey sign-in.");
      const { options, challengeId } = await optRes.json();
      const credential = await startAuthentication({ optionsJSON: options });
      const res = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          challengeId,
          credential,
          redirectTo: data.redirectTo,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? "The passkey could not be verified.");
      }
      await goto(body.redirectTo, { invalidateAll: true });
    } catch (err) {
      passkeyError =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Passkey sign-in was cancelled."
          : err instanceof Error
            ? err.message
            : "Passkey sign-in failed.";
    } finally {
      passkeyBusy = false;
    }
  }
</script>

<svelte:head>
  <title>Log in · Kept</title>
</svelte:head>

<AuthCard>
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-xl">Log in</Card.Title>
      <Card.Description>Sign in to your Kept account.</Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        method="POST"
        class="flex flex-col gap-4"
        use:enhance={() => {
          pending = true;
          return async ({ update }) => {
            await update({ reset: false });
            pending = false;
          };
        }}
      >
        <input type="hidden" name="redirectTo" value={data.redirectTo} />
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
              autofocus
              value={form?.values?.username ?? ""}
              aria-invalid={hasError(form?.errors, "username")}
            />
            <Field.Error errors={fieldErrors(form?.errors, "username")} />
          </Field.Field>
          <Field.Field>
            <Field.Label for="password">Password</Field.Label>
            <Input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              aria-invalid={hasError(form?.errors, "password")}
            />
            <Field.Error errors={fieldErrors(form?.errors, "password")} />
          </Field.Field>
        </Field.Group>
        <Button type="submit" disabled={pending} class="w-full">
          {#if pending}<Spinner />Logging in…{:else}Log in{/if}
        </Button>
      </form>
      {#if passkeysSupported}
        <div class="mt-4 flex flex-col gap-3">
          <FormAlert message={passkeyError} />
          <Button
            type="button"
            variant="outline"
            class="w-full"
            disabled={passkeyBusy}
            onclick={signInWithPasskey}
          >
            {#if passkeyBusy}<Spinner />{:else}<KeyRoundIcon />{/if}
            Sign in with a passkey
          </Button>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
</AuthCard>
