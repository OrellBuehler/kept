<script lang="ts">
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import CopyButton from "$lib/components/app/copy-button.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import type { WorkflowRecipe } from "$lib/server/integrations/paperless/setup";
  import SecretBox from "./secret-box.svelte";

  let {
    webhookUrl,
    recipe,
    secret,
    ondismisssecret,
  }: {
    webhookUrl: string;
    recipe: WorkflowRecipe;
    secret: string | null;
    ondismisssecret: () => void;
  } = $props();

  let rotateOpen = $state(false);
  const headerName = $derived(Object.keys(recipe.action.headers)[0]);
  const paramsJson = $derived(JSON.stringify(recipe.action.params, null, 2));
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Webhook</Card.Title>
    <Card.Description>
      Optional. A Paperless workflow tells Kept about new documents at once.
      Without it, Kept still checks every 30 minutes and on Sync now.
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-6">
    {#if secret}
      <SecretBox {secret} ondismiss={ondismisssecret} />
    {/if}

    <div class="grid gap-1.5">
      <Label for="webhook-url">Webhook address</Label>
      <div class="flex gap-2">
        <Input
          id="webhook-url"
          readonly
          value={webhookUrl}
          class="min-w-0 font-mono text-xs"
          onfocus={(e) => e.currentTarget.select()}
        />
        <CopyButton
          value={webhookUrl}
          iconOnly
          label="Copy webhook address"
          copiedMessage="Address copied"
        />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        onclick={() => (rotateOpen = true)}
      >
        <RefreshCwIcon /> Rotate secret
      </Button>
      <p class="text-muted-foreground min-w-0 flex-1 text-xs">
        Creates a new secret and stops the old one working. Update the header in
        the Paperless workflow afterwards.
      </p>
    </div>

    <section
      class="grid grid-cols-[minmax(0,1fr)] gap-3"
      aria-labelledby="recipe-heading"
    >
      <h3 id="recipe-heading" class="text-sm font-medium">{recipe.title}</h3>
      <ol
        class="grid list-decimal grid-cols-[minmax(0,1fr)] gap-1.5 ps-5 text-sm"
      >
        {#each recipe.steps as step, i (i)}
          <li class="min-w-0 ps-1 break-words">{step}</li>
        {/each}
      </ol>

      <dl
        class="bg-muted/40 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-md border p-3 text-sm"
        aria-label="Webhook action settings"
      >
        <dt class="text-muted-foreground">Trigger</dt>
        <dd>
          {recipe.trigger.type}{#if recipe.trigger.filterTag}, tag
            <span class="font-medium">{recipe.trigger.filterTag}</span>{/if}
        </dd>
        <dt class="text-muted-foreground">Method</dt>
        <dd class="font-mono text-xs">{recipe.action.method}</dd>
        <dt class="text-muted-foreground">URL</dt>
        <dd class="min-w-0 font-mono text-xs break-all">{recipe.action.url}</dd>
        <dt class="text-muted-foreground">Parameters</dt>
        <dd class="min-w-0">
          <pre class="overflow-x-auto font-mono text-xs">{paramsJson}</pre>
        </dd>
        <dt class="text-muted-foreground">Header</dt>
        <dd class="min-w-0 font-mono text-xs break-all">{headerName}</dd>
      </dl>

      {#if recipe.notes.length > 0}
        <ul
          class="text-muted-foreground grid list-disc grid-cols-[minmax(0,1fr)] gap-1 ps-5 text-xs"
        >
          {#each recipe.notes as note (note)}
            <li class="break-words">{note}</li>
          {/each}
        </ul>
      {/if}
    </section>
  </Card.Content>
</Card.Root>

<ConfirmActionDialog
  bind:open={rotateOpen}
  title="Rotate the webhook secret?"
  description="The current secret stops working immediately. Kept shows the new one once; paste it into the Paperless workflow header afterwards, or new documents are no longer imported at once."
  action="?/rotateSecret"
  confirmLabel="Rotate secret"
  successMessage="Secret rotated."
/>
