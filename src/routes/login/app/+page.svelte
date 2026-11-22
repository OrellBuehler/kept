<script lang="ts">
  import { enhance } from "$app/forms";
  import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import AuthCard from "$lib/components/app/auth-card.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { formError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let pending = $state(false);
  const callback = $derived(
    form && "callback" in form && typeof form.callback === "string"
      ? form.callback
      : null,
  );

  $effect(() => {
    if (callback) window.location.assign(callback);
  });
</script>

<svelte:head>
  <title>Sign in to the app · Kept</title>
</svelte:head>

<AuthCard>
  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2 text-xl">
        <SmartphoneIcon class="size-5" /> Sign in to the Kept app
      </Card.Title>
      <Card.Description>
        {#if callback}
          You are signed in. Returning to the app…
        {:else if data.open}
          The Kept app is asking to sign in as
          <span class="text-foreground font-medium">{data.name}</span>.
        {:else}
          This sign-in has expired or was already used.
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-4">
      {#if callback}
        <p class="text-muted-foreground text-sm">
          If nothing happens, continue manually.
        </p>
        <Button href={callback} data-sveltekit-reload class="w-full">
          Return to the app
        </Button>
      {:else if data.open}
        <FormAlert message={formError(form?.errors)} />
        <p class="text-muted-foreground text-sm">
          Continue only if you started this from the app yourself. The app gets
          full access to your Kept account until you sign it out.
        </p>
        <form
          method="POST"
          class="flex flex-col gap-3"
          use:enhance={() => {
            pending = true;
            return async ({ update }) => {
              await update({ reset: false });
              pending = false;
            };
          }}
        >
          <input type="hidden" name="request" value={data.request} />
          <Button type="submit" disabled={pending} class="w-full">
            {#if pending}<Spinner />Signing in…{:else}Continue as {data.username}{/if}
          </Button>
        </form>
      {:else}
        <FormAlert message={formError(form?.errors)} />
        <p class="text-muted-foreground text-sm">
          Go back to the app and start again.
        </p>
      {/if}
    </Card.Content>
  </Card.Root>
</AuthCard>
