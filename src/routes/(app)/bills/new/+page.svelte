<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import InfoIcon from "@lucide/svelte/icons/info";
  import PencilLineIcon from "@lucide/svelte/icons/pencil-line";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Alert from "$lib/components/ui/alert";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import BillForm from "$lib/components/bills/BillForm.svelte";
  import DocumentUpload from "$lib/components/bills/DocumentUpload.svelte";
  import { emptyBillValues, type BillFormValues } from "$lib/bill-display";
  import { formatIban } from "$lib/iban";
  import { formatReference } from "$lib/references";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let manual = $state(false);
  const showForm = $derived(
    manual || data.documentId !== null || page.url.searchParams.has("manual"),
  );

  const values = $derived.by((): BillFormValues => {
    const d = data.draft;
    if (!d) return emptyBillValues();
    return {
      ...emptyBillValues(),
      ...d,
      creditorIban: d.creditorIban ? formatIban(d.creditorIban) : "",
      reference: d.reference ? formatReference(d.reference) : "",
    };
  });

  const source = $derived(data.extraction?.source ?? null);
  const warnings = $derived(data.extraction?.warnings ?? []);
</script>

<svelte:head>
  <title>Add bill · Kept</title>
</svelte:head>

<div class="mx-auto grid w-full max-w-2xl gap-6">
  <div class="grid gap-1">
    <a
      href={resolve("/(app)/bills")}
      class="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
    >
      <ArrowLeftIcon class="size-4" /> Bills
    </a>
    <h1 class="text-2xl font-semibold tracking-tight">Add bill</h1>
  </div>

  {#if !showForm}
    <Card.Root>
      <Card.Header>
        <Card.Title>Upload the bill</Card.Title>
        <Card.Description>
          Kept reads the QR code of a Swiss QR-bill and fills the form for you.
          Nothing is saved until you check the values and press Save.
        </Card.Description>
      </Card.Header>
      <Card.Content class="grid gap-4">
        <DocumentUpload action="?/upload" />
        <p class="text-muted-foreground text-xs">
          eBill: download the invoice PDF in your e-banking and upload it here.
        </p>
        <div class="flex items-center gap-3">
          <div class="bg-border h-px flex-1"></div>
          <span class="text-muted-foreground text-xs">or</span>
          <div class="bg-border h-px flex-1"></div>
        </div>
        <Button variant="outline" onclick={() => (manual = true)}>
          <PencilLineIcon /> Enter manually
        </Button>
      </Card.Content>
    </Card.Root>
  {:else}
    {#if source === "qr"}
      <Alert.Root
        class="border-emerald-600/40 text-emerald-800 dark:border-emerald-400/40 dark:text-emerald-300"
      >
        <CircleCheckIcon />
        <Alert.Title>Read from the QR code</Alert.Title>
        <Alert.Description class="text-emerald-800/90 dark:text-emerald-300/90">
          Check the values below, then save the bill.
        </Alert.Description>
      </Alert.Root>
    {:else if source === "text"}
      <Alert.Root
        class="border-amber-600/40 text-amber-800 dark:border-amber-400/40 dark:text-amber-300"
      >
        <TriangleAlertIcon />
        <Alert.Title>Read from the text</Alert.Title>
        <Alert.Description class="text-amber-800/90 dark:text-amber-300/90">
          Guessed from the text — please check every field.
        </Alert.Description>
      </Alert.Root>
    {:else if source === "none"}
      <Alert.Root>
        <InfoIcon />
        <Alert.Title>Nothing could be read</Alert.Title>
        <Alert.Description>
          The PDF has no QR code or recognisable text. Enter the details
          yourself; the PDF is kept with the bill.
        </Alert.Description>
      </Alert.Root>
    {/if}

    {#if warnings.length > 0}
      <ul class="text-muted-foreground grid gap-1 text-sm">
        {#each warnings as warning (warning)}
          <li class="flex gap-2">
            <TriangleAlertIcon
              class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <span>{warning}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <Card.Root>
      <Card.Content>
        {#key data.documentId}
          <BillForm
            action="?/create"
            {values}
            accounts={data.accounts}
            documentId={data.documentId}
            submitLabel="Save bill"
            successMessage="Bill saved"
          />
        {/key}
      </Card.Content>
    </Card.Root>
    {#if data.documentId}
      <p class="text-muted-foreground text-xs">
        The uploaded PDF is attached when you save. A preview is available on
        the bill's page.
      </p>
    {/if}
  {/if}
</div>
