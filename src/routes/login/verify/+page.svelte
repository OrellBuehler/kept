<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { startAuthentication } from "@simplewebauthn/browser";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as InputOTP from "$lib/components/ui/input-otp/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import AuthCard from "$lib/components/app/auth-card.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let pending = $state(false);
  let useRecovery = $state(false);
  let code = $state("");
  let passkeyBusy = $state(false);
  let passkeyError = $state<string | undefined>();

  async function usePasskey() {
    passkeyError = undefined;
    passkeyBusy = true;
    try {
      const headers = { "content-type": "application/json" };
      const optRes = await fetch("/api/auth/passkey/login/options", {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "second_factor" }),
      });
      if (!optRes.ok) throw new Error("Could not start passkey sign-in.");
      const { options } = await optRes.json();
      const credential = await startAuthentication({ optionsJSON: options });
      const res = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({ credential, redirectTo: data.redirectTo }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? "The passkey could not be verified.");
      }
      await goto(body.redirectTo, { refreshAll: true });
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
  <title>Verify · Kept</title>
</svelte:head>

<AuthCard>
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-xl">Two-step verification</Card.Title>
      <Card.Description>
        {#if useRecovery}
          Enter one of your recovery codes.
        {:else if data.totp}
          Enter the 6-digit code from your authenticator app.
        {:else}
          Use one of your passkeys to finish signing in.
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      {#if data.totp}
        <form
          method="POST"
          class="flex flex-col gap-4"
          use:enhance={() => {
            pending = true;
            return async ({ update }) => {
              await update({ reset: false });
              code = "";
              pending = false;
            };
          }}
        >
          <input type="hidden" name="redirectTo" value={data.redirectTo} />
          <FormAlert message={formError(form?.errors)} />
          <Field.Field>
            {#if useRecovery}
              <Field.Label for="code">Recovery code</Field.Label>
              <Input
                id="code"
                name="code"
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                required
                autofocus
                aria-invalid={hasError(form?.errors, "code")}
              />
            {:else}
              <Field.Label for="code">Authenticator code</Field.Label>
              <InputOTP.Root
                id="code"
                maxlength={6}
                name="code"
                bind:value={code}
                inputmode="numeric"
                autocomplete="one-time-code"
                autofocus
              >
                {#snippet children({ cells })}
                  <InputOTP.Group>
                    {#each cells as cell, i (i)}
                      <InputOTP.Slot {cell} />
                    {/each}
                  </InputOTP.Group>
                {/snippet}
              </InputOTP.Root>
            {/if}
            <Field.Error errors={fieldErrors(form?.errors, "code")} />
          </Field.Field>
          <Button
            type="submit"
            disabled={pending || (!useRecovery && code.length < 6)}
            class="w-full"
          >
            {#if pending}<Spinner />Verifying…{:else}Verify{/if}
          </Button>
          <Button
            type="button"
            variant="link"
            class="self-center"
            onclick={() => {
              useRecovery = !useRecovery;
              code = "";
            }}
          >
            {useRecovery ? "Use authenticator code" : "Use a recovery code"}
          </Button>
        </form>
      {:else}
        <FormAlert message={formError(form?.errors)} />
      {/if}

      {#if data.passkeys}
        <FormAlert message={passkeyError} />
        <Button
          type="button"
          variant={data.totp ? "outline" : "default"}
          class="w-full"
          disabled={passkeyBusy}
          onclick={usePasskey}
        >
          {#if passkeyBusy}<Spinner />{:else}<KeyRoundIcon />{/if}
          Use a passkey
        </Button>
      {/if}

      <form method="POST" action="?/cancel">
        <Button type="submit" variant="ghost" class="w-full">
          Back to log in
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</AuthCard>
