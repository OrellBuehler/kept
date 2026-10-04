<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import {
    startAuthentication,
    startRegistration,
  } from "@simplewebauthn/browser";
  import { toast } from "svelte-sonner";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as InputOTP from "$lib/components/ui/input-otp/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import CopyButton from "$lib/components/app/copy-button.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let pending = $state<string | null>(null);
  let lastAction = $state<string | null>(null);
  let confirmCode = $state("");
  let shownCodes = $state<string[] | null>(null);
  let passkeyName = $state("");
  let passkeyBusy = $state(false);
  let passkeyError = $state<string | undefined>();
  const passkeysSupported =
    typeof window !== "undefined" && !!window.PublicKeyCredential;

  const errorsFor = (action: string) =>
    lastAction === action && form && "errors" in form ? form.errors : undefined;

  function submit(action: string, done?: string) {
    return () => {
      pending = action;
      lastAction = action;
      return async ({
        result,
        update,
      }: {
        result: { type: string; data?: Record<string, unknown> };
        update: (o?: { reset?: boolean }) => Promise<void>;
      }) => {
        await update({ reset: result.type === "success" });
        pending = null;
        if (result.type === "success") {
          const codes = result.data?.recoveryCodes;
          if (Array.isArray(codes)) shownCodes = codes as string[];
          confirmCode = "";
          if (done) toast.success(done);
        } else if (result.type === "error") {
          toast.error("Something went wrong. Please try again.");
        }
      };
    };
  }

  const passkeyOnly = $derived(
    !data.status.totpEnabled && data.status.passkeyCount > 0,
  );
  let stepUpPassword = $state("");

  async function confirmWithPasskey() {
    passkeyError = undefined;
    passkeyBusy = true;
    try {
      const headers = { "content-type": "application/json" };
      const optRes = await fetch("/api/auth/passkey/stepup/options", {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!optRes.ok) throw new Error("Could not start confirmation.");
      const { options, challengeId } = await optRes.json();
      const credential = await startAuthentication({ optionsJSON: options });
      const res = await fetch("/api/auth/passkey/stepup/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          challengeId,
          password: stepUpPassword,
          credential,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Confirmation failed.");
      }
      stepUpPassword = "";
      toast.success("Confirmed. You can change passkeys for 5 minutes.");
      await invalidateAll();
    } catch (err) {
      passkeyError =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Confirmation was cancelled."
          : err instanceof Error
            ? err.message
            : "Confirmation failed.";
    } finally {
      passkeyBusy = false;
    }
  }

  async function addPasskey() {
    passkeyError = undefined;
    passkeyBusy = true;
    try {
      const name = passkeyName.trim() || "Passkey";
      const headers = { "content-type": "application/json" };
      const optRes = await fetch("/api/auth/passkey/register/options", {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!optRes.ok) throw new Error("Could not start passkey registration.");
      const { options, challengeId } = await optRes.json();
      const credential = await startRegistration({ optionsJSON: options });
      const res = await fetch("/api/auth/passkey/register/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({ challengeId, name, credential }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "The passkey could not be verified.");
      }
      passkeyName = "";
      toast.success("Passkey added.");
      await invalidateAll();
    } catch (err) {
      passkeyError =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Passkey registration was cancelled."
          : err instanceof Error
            ? err.message
            : "Passkey registration failed.";
    } finally {
      passkeyBusy = false;
    }
  }
</script>

<svelte:head>
  <title>Security · Kept</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight md:text-3xl">Security</h1>

<div class="grid max-w-xl gap-6">
  {#if shownCodes}
    <Card.Root>
      <Card.Header>
        <Card.Title>Recovery codes</Card.Title>
        <Card.Description>
          Store these somewhere safe. Each code works once and they are shown
          only now.
        </Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        <ul class="grid grid-cols-2 gap-2 font-mono text-sm">
          {#each shownCodes as code (code)}<li>{code}</li>{/each}
        </ul>
        <div class="flex gap-2">
          <CopyButton value={shownCodes.join("\n")} label="Copy codes" />
          <Button variant="outline" onclick={() => (shownCodes = null)}>
            I have saved them
          </Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        Authenticator app
        <Badge variant={data.status.totpEnabled ? "default" : "secondary"}>
          {data.status.totpEnabled ? "On" : "Off"}
        </Badge>
      </Card.Title>
      <Card.Description>
        Ask for a 6-digit code from an authenticator app after your password.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      {#if data.status.totpEnabled}
        <p class="text-muted-foreground text-sm">
          {data.status.recoveryCodesRemaining} recovery codes left.
        </p>
        <form
          method="POST"
          action="?/regenerateRecoveryCodes"
          class="flex flex-col gap-3"
          use:enhance={submit("regenerateRecoveryCodes")}
        >
          <FormAlert
            message={formError(errorsFor("regenerateRecoveryCodes"))}
          />
          <Field.Group>
            <Field.Field>
              <Field.Label for="regen-password">Password</Field.Label>
              <Input
                id="regen-password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                aria-invalid={hasError(
                  errorsFor("regenerateRecoveryCodes"),
                  "password",
                )}
              />
              <Field.Error
                errors={fieldErrors(
                  errorsFor("regenerateRecoveryCodes"),
                  "password",
                )}
              />
            </Field.Field>
            <Field.Field>
              <Field.Label for="regen-code">Authenticator code</Field.Label>
              <Input
                id="regen-code"
                name="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                required
                aria-invalid={hasError(
                  errorsFor("regenerateRecoveryCodes"),
                  "code",
                )}
              />
              <Field.Error
                errors={fieldErrors(
                  errorsFor("regenerateRecoveryCodes"),
                  "code",
                )}
              />
            </Field.Field>
          </Field.Group>
          <div class="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" disabled={pending !== null}>
              {#if pending === "regenerateRecoveryCodes"}<Spinner />{/if}
              Regenerate recovery codes
            </Button>
            <Button
              type="submit"
              variant="destructive"
              formaction="?/disableTotp"
              disabled={pending !== null}
              onclick={() => (lastAction = "disableTotp")}
            >
              Disable
            </Button>
          </div>
          <FormAlert message={formError(errorsFor("disableTotp"))} />
        </form>
      {:else if data.enrolment}
        <div class="flex flex-col items-center gap-3">
          <img
            src={data.enrolment.qr}
            alt="QR code for the authenticator app"
            width="224"
            height="224"
            class="rounded-md bg-white"
          />
          <p class="text-muted-foreground text-sm">
            Or enter this key manually:
          </p>
          <code class="bg-muted rounded px-2 py-1 text-sm break-all"
            >{data.enrolment.secret}</code
          >
        </div>
        <form
          method="POST"
          action="?/confirmTotp"
          class="flex flex-col gap-3"
          use:enhance={submit("confirmTotp", "Authenticator app enabled.")}
        >
          <FormAlert message={formError(errorsFor("confirmTotp"))} />
          <Field.Field>
            <Field.Label for="confirm-password">Password</Field.Label>
            <Input
              id="confirm-password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              aria-invalid={hasError(errorsFor("confirmTotp"), "password")}
            />
            <Field.Error
              errors={fieldErrors(errorsFor("confirmTotp"), "password")}
            />
          </Field.Field>
          <Field.Field>
            <Field.Label for="confirm-code">
              Enter the current code to finish
            </Field.Label>
            <InputOTP.Root
              id="confirm-code"
              maxlength={6}
              name="code"
              bind:value={confirmCode}
              inputmode="numeric"
              autocomplete="one-time-code"
            >
              {#snippet children({ cells })}
                <InputOTP.Group>
                  {#each cells as cell, i (i)}
                    <InputOTP.Slot {cell} />
                  {/each}
                </InputOTP.Group>
              {/snippet}
            </InputOTP.Root>
            <Field.Error
              errors={fieldErrors(errorsFor("confirmTotp"), "code")}
            />
          </Field.Field>
          <div class="flex gap-2">
            <Button
              type="submit"
              disabled={pending !== null || confirmCode.length < 6}
            >
              {#if pending === "confirmTotp"}<Spinner />{/if}
              Enable
            </Button>
            <Button
              type="submit"
              variant="outline"
              formaction="?/cancelTotp"
              formnovalidate
              disabled={pending !== null}
            >
              Cancel
            </Button>
          </div>
        </form>
      {:else}
        <form
          method="POST"
          action="?/startTotp"
          class="flex flex-col gap-3"
          use:enhance={submit("startTotp")}
        >
          <FormAlert message={formError(errorsFor("startTotp"))} />
          <Field.Field>
            <Field.Label for="start-password">Password</Field.Label>
            <Input
              id="start-password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              aria-invalid={hasError(errorsFor("startTotp"), "password")}
            />
            <Field.Error
              errors={fieldErrors(errorsFor("startTotp"), "password")}
            />
          </Field.Field>
          <Button type="submit" class="self-start" disabled={pending !== null}>
            Set up authenticator app
          </Button>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        Passkeys
        <Badge variant={data.passkeys.length > 0 ? "default" : "secondary"}>
          {data.passkeys.length}
        </Badge>
      </Card.Title>
      <Card.Description>
        Passkeys can be used instead of a password, or as the second step after
        it.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      <ul class="grid gap-3">
        {#each data.passkeys as passkey (passkey.id)}
          <li class="flex items-end gap-2">
            <form
              method="POST"
              action="?/renamePasskey"
              class="flex min-w-0 flex-1 items-end gap-2"
              use:enhance={submit("renamePasskey", "Passkey renamed.")}
            >
              <input type="hidden" name="id" value={passkey.id} />
              <Field.Field class="min-w-0 flex-1">
                <Field.Label for={`pk-${passkey.id}`}>
                  <KeyRoundIcon class="size-4" />
                  Name
                </Field.Label>
                <Input
                  id={`pk-${passkey.id}`}
                  name="name"
                  value={passkey.name}
                  maxlength={64}
                  required
                />
              </Field.Field>
              <Button
                type="submit"
                variant="outline"
                disabled={pending !== null}
              >
                Rename
              </Button>
            </form>
            <form
              method="POST"
              action="?/deletePasskey"
              use:enhance={submit("deletePasskey", "Passkey removed.")}
            >
              <input type="hidden" name="id" value={passkey.id} />
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                class="text-destructive hover:text-destructive"
                aria-label={`Delete ${passkey.name}`}
                disabled={pending !== null}
              >
                <Trash2Icon />
              </Button>
            </form>
          </li>
        {/each}
      </ul>
      <FormAlert
        message={formError(errorsFor("renamePasskey")) ??
          formError(errorsFor("deletePasskey"))}
      />
      {#if !data.reauthed}
        <form
          method="POST"
          action="?/stepUp"
          class="flex flex-col gap-3"
          use:enhance={submit(
            "stepUp",
            "Confirmed. You can change passkeys for 5 minutes.",
          )}
        >
          <p class="text-muted-foreground text-sm">
            Confirm it is you to add or remove passkeys.
          </p>
          <FormAlert message={formError(errorsFor("stepUp"))} />
          <Field.Group>
            <Field.Field>
              <Field.Label for="stepup-password">Password</Field.Label>
              <Input
                id="stepup-password"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                bind:value={stepUpPassword}
                aria-invalid={hasError(errorsFor("stepUp"), "password")}
              />
              <Field.Error
                errors={fieldErrors(errorsFor("stepUp"), "password")}
              />
            </Field.Field>
            {#if data.status.totpEnabled}
              <Field.Field>
                <Field.Label for="stepup-code">Authenticator code</Field.Label>
                <Input
                  id="stepup-code"
                  name="code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  required
                  aria-invalid={hasError(errorsFor("stepUp"), "code")}
                />
                <Field.Error
                  errors={fieldErrors(errorsFor("stepUp"), "code")}
                />
              </Field.Field>
            {/if}
          </Field.Group>
          <FormAlert message={passkeyError} />
          {#if passkeyOnly}
            <Button
              type="button"
              class="self-start"
              disabled={passkeyBusy || stepUpPassword.length === 0}
              onclick={confirmWithPasskey}
            >
              {#if passkeyBusy}<Spinner />{/if}
              Confirm with passkey
            </Button>
          {:else}
            <Button
              type="submit"
              class="self-start"
              disabled={pending !== null}
            >
              {#if pending === "stepUp"}<Spinner />{/if}
              Confirm
            </Button>
          {/if}
        </form>
      {/if}
      {#if passkeysSupported}
        <div class="flex flex-col gap-3">
          <FormAlert message={passkeyError} />
          <Field.Field>
            <Field.Label for="passkey-name">New passkey name</Field.Label>
            <Input
              id="passkey-name"
              bind:value={passkeyName}
              placeholder="e.g. Laptop"
              maxlength={64}
            />
          </Field.Field>
          <Button
            type="button"
            class="self-start"
            disabled={passkeyBusy || !data.reauthed}
            onclick={addPasskey}
          >
            {#if passkeyBusy}<Spinner />{/if}
            Add passkey
          </Button>
        </div>
      {:else}
        <p class="text-muted-foreground text-sm">
          This browser does not support passkeys, or the page is not served over
          HTTPS.
        </p>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
