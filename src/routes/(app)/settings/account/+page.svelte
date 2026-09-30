<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let pending = $state(false);
  let newPassword = $state("");
  let confirm = $state("");
  let touchedConfirm = $state(false);

  const mismatch = $derived(touchedConfirm && confirm !== newPassword);
</script>

<svelte:head>
  <title>Account settings · Kept</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">Account settings</h1>

<div class="grid max-w-xl gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Profile</Card.Title>
    </Card.Header>
    <Card.Content>
      <dl
        class="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm"
      >
        <dt class="text-muted-foreground">Username</dt>
        <dd class="min-w-0 font-medium break-words">{data.user.username}</dd>
        <dt class="text-muted-foreground">Display name</dt>
        <dd class="min-w-0 break-words">
          {#if data.user.displayName}
            {data.user.displayName}
          {:else}
            <span class="text-muted-foreground">Not set</span>
          {/if}
        </dd>
        <dt class="text-muted-foreground">Role</dt>
        <dd>
          <Badge variant={data.user.role === "admin" ? "default" : "secondary"}>
            {data.user.role === "admin" ? "Admin" : "Member"}
          </Badge>
        </dd>
      </dl>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Change password</Card.Title>
      <Card.Description>
        Other devices are signed out when you change your password.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        method="POST"
        action="?/changePassword"
        class="flex flex-col gap-4"
        use:enhance={({ cancel }) => {
          touchedConfirm = true;
          if (confirm !== newPassword) {
            cancel();
            return;
          }
          pending = true;
          return async ({ result, update }) => {
            await update();
            pending = false;
            if (result.type === "success") {
              newPassword = "";
              confirm = "";
              touchedConfirm = false;
              toast.success("Password changed.");
            } else if (result.type === "failure") {
              toast.error("Password was not changed.");
            } else if (result.type === "error") {
              toast.error("Something went wrong. Please try again.");
            }
          };
        }}
      >
        <FormAlert message={formError(form?.errors)} />
        <Field.Group>
          <Field.Field>
            <Field.Label for="currentPassword">Current password</Field.Label>
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autocomplete="current-password"
              required
              aria-invalid={hasError(form?.errors, "currentPassword")}
            />
            <Field.Error
              errors={fieldErrors(form?.errors, "currentPassword")}
            />
          </Field.Field>
          <Field.Field>
            <Field.Label for="newPassword">New password</Field.Label>
            <Input
              id="newPassword"
              name="newPassword"
              type="password"
              autocomplete="new-password"
              required
              minlength={10}
              bind:value={newPassword}
              aria-invalid={hasError(form?.errors, "newPassword")}
            />
            <Field.Description>At least 10 characters.</Field.Description>
            <Field.Error errors={fieldErrors(form?.errors, "newPassword")} />
          </Field.Field>
          <Field.Field>
            <Field.Label for="confirm">Confirm new password</Field.Label>
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
        <Button type="submit" disabled={pending} class="self-start">
          {#if pending}<Spinner />Saving…{:else}Change password{/if}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</div>
