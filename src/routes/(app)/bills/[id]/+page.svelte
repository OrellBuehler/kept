<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { MediaQuery, SvelteURLSearchParams } from "svelte/reactivity";
  import { toast } from "svelte-sonner";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import BanIcon from "@lucide/svelte/icons/ban";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import UndoIcon from "@lucide/svelte/icons/undo-2";
  import Amount from "$lib/components/Amount.svelte";
  import BillForm from "$lib/components/bills/BillForm.svelte";
  import BillStatusBadge from "$lib/components/bills/BillStatusBadge.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import DocumentUpload from "$lib/components/bills/DocumentUpload.svelte";
  import SuggestionCard from "$lib/components/bills/SuggestionCard.svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import {
    KIND_LABELS,
    billToFormValues,
    mergeRereadDraft,
    dueHint,
    type BillFormValues,
  } from "$lib/bill-display";
  import { formatReference } from "$lib/references";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { formatDate } from "$lib/format";
  import { formatIban, maskIban } from "$lib/iban";
  import AllocationRow from "./AllocationRow.svelte";
  import CandidateRow from "./CandidateRow.svelte";
  import DismissedRow from "./DismissedRow.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const bill = $derived(data.bill);
  const hint = $derived(dueHint(bill));
  const documentUrl = $derived(
    resolve("/(app)/bills/[id]/document", { id: bill.id }),
  );
  const externalUrl = $derived(
    bill.externalUrl && /^https?:\/\//i.test(bill.externalUrl)
      ? bill.externalUrl
      : null,
  );

  let shownFor = $state<string | null>(null);
  const candidatesCollapsed = $derived(
    (bill.status === "paid" || bill.status === "cancelled") &&
      shownFor !== bill.id &&
      !data.candidateQuery,
  );

  let editOpen = $state(false);
  let deleteOpen = $state(false);
  let showIban = $state(false);
  let reviewDraft = $state<Partial<BillFormValues> | null>(null);
  let reviewSource = $state<"qr" | "text" | "none">("none");
  let editKey = $state(0);
  let reextracting = $state(false);
  let reextractError = $state("");
  let togglingCancel = $state(false);
  let cancelErrors = $state<NonNullable<FormErrors>>({});

  const formValues = $derived.by((): BillFormValues => {
    const base = billToFormValues(bill);
    if (!reviewDraft) return base;
    return mergeRereadDraft(base, reviewDraft, {
      source: reviewSource,
      hasAllocations: bill.allocationCount > 0,
    });
  });

  function openEdit() {
    reviewDraft = null;
    editKey++;
    editOpen = true;
  }

  const desktop = new MediaQuery("min-width: 768px");
  let mounted = $state(false);
  onMount(() => (mounted = true));

  const hasDetails = $derived(
    !!(
      bill.creditorIban ||
      bill.reference ||
      bill.message ||
      bill.issueDate ||
      bill.expectedAccountId ||
      bill.taxYear ||
      bill.notes ||
      externalUrl
    ),
  );

  const expectedAccount = $derived(
    data.accounts.find((a) => a.id === bill.expectedAccountId)?.name ?? null,
  );

  function pageHref(page: number) {
    const params = new SvelteURLSearchParams();
    if (data.candidateQuery) params.set("q", data.candidateQuery);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return resolve("/(app)/bills/[id]", { id: bill.id }) + (qs ? `?${qs}` : "");
  }

  function fileSize(bytes: number) {
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<svelte:head>
  <title>{bill.creditorName ?? "Bill"} · Bills · Kept</title>
</svelte:head>

<div class="mx-auto grid w-full max-w-3xl gap-6">
  <a
    href={resolve("/(app)/bills")}
    class="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
  >
    <ArrowLeftIcon class="size-4" /> Bills
  </a>

  <Card.Root>
    <Card.Header>
      <div class="flex flex-wrap items-center gap-2">
        <Card.Title class="text-xl break-words">
          {bill.creditorName ?? "Unnamed creditor"}
        </Card.Title>
        <BillStatusBadge status={bill.status} />
        {#if bill.kind === "credit_note"}
          <Badge variant="outline">{KIND_LABELS.credit_note}</Badge>
        {/if}
      </div>
      <Card.Description>
        {#if bill.invoiceNumber}No. {bill.invoiceNumber} ·
        {/if}
        {#if bill.dueDate}
          Due {formatDate(bill.dueDate)}
          {#if hint}
            <span
              class={bill.overdue
                ? "text-destructive font-medium"
                : "text-foreground font-medium"}>· {hint}</span
            >
          {/if}
        {:else}
          No due date
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      <dl class="flex flex-wrap gap-x-8 gap-y-3">
        <div class="grid gap-0.5">
          <dt class="text-muted-foreground text-xs">Amount</dt>
          <dd class="text-lg font-semibold">
            {#if bill.amount !== null}
              <Amount value={bill.amount} currency={bill.currency} />
            {:else}
              <span class="text-muted-foreground text-sm font-normal">
                Open amount
              </span>
            {/if}
          </dd>
        </div>
        <div class="grid gap-0.5">
          <dt class="text-muted-foreground text-xs">Settled</dt>
          <dd class="text-lg font-semibold">
            <Amount value={bill.settled} currency={bill.currency} />
          </dd>
        </div>
        <div class="grid gap-0.5">
          <dt class="text-muted-foreground text-xs">Remaining</dt>
          <dd class="text-lg font-semibold">
            {#if bill.remaining !== null}
              <Amount value={bill.remaining} currency={bill.currency} />
            {:else}
              <span class="text-muted-foreground text-sm font-normal">–</span>
            {/if}
          </dd>
        </div>
      </dl>

      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onclick={openEdit}>
          <PencilIcon /> Edit
        </Button>
        <form
          method="POST"
          action={bill.cancelled ? "?/uncancel" : "?/cancel"}
          use:enhance={submitHandler({
            setPending: (v) => (togglingCancel = v),
            setErrors: (e) => (cancelErrors = e),
            knownFields: [],
            successMessage: bill.cancelled ? "Bill restored" : "Bill cancelled",
          })}
        >
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={togglingCancel}
          >
            {#if togglingCancel}<Spinner />{:else if bill.cancelled}<UndoIcon
              />{:else}<BanIcon />{/if}
            {bill.cancelled ? "Uncancel" : "Cancel bill"}
          </Button>
        </form>
        {#if bill.documentId}
          <form
            method="POST"
            action="?/reextract"
            use:enhance={() => {
              reextracting = true;
              reextractError = "";
              return async ({ result }) => {
                reextracting = false;
                if (result.type === "success" && result.data?.draft) {
                  reviewDraft = result.data.draft as Partial<BillFormValues>;
                  reviewSource =
                    (
                      result.data.extraction as
                        { source?: "qr" | "text" | "none" } | undefined
                    )?.source ?? "none";
                  editKey++;
                  editOpen = true;
                } else if (result.type === "failure") {
                  const errors = (result.data?.errors ?? {}) as Record<
                    string,
                    string[]
                  >;
                  reextractError =
                    Object.values(errors).flat().join(" ") ||
                    "Could not read the PDF again.";
                } else {
                  console.error("re-read failed");
                  reextractError = "Something went wrong. Please try again.";
                  toast.error(reextractError);
                }
              };
            }}
          >
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={reextracting}
            >
              {#if reextracting}<Spinner />{:else}<RefreshCwIcon />{/if}
              Re-read PDF
            </Button>
          </form>
        {/if}
        <Button
          variant="outline"
          size="sm"
          class="text-destructive"
          onclick={() => (deleteOpen = true)}
        >
          <Trash2Icon /> Delete
        </Button>
      </div>
      {#each [...Object.values(cancelErrors).flat(), ...(reextractError ? [reextractError] : [])] as message (message)}
        <p class="text-destructive text-sm" role="alert">{message}</p>
      {/each}
    </Card.Content>
  </Card.Root>

  {#if hasDetails}
    <Card.Root>
      <Card.Header>
        <Card.Title class="text-base">Details</Card.Title>
      </Card.Header>
      <Card.Content>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {#if bill.creditorIban}
            <dt class="text-muted-foreground">IBAN</dt>
            <dd class="flex flex-wrap items-center gap-2">
              <span class="font-mono break-all">
                {showIban
                  ? formatIban(bill.creditorIban)
                  : maskIban(bill.creditorIban)}
              </span>
              <button
                type="button"
                class="text-muted-foreground text-xs underline"
                aria-pressed={showIban}
                aria-label={showIban ? "Hide full IBAN" : "Show full IBAN"}
                onclick={() => (showIban = !showIban)}
              >
                {showIban ? "hide" : "show"}
              </button>
            </dd>
          {/if}
          {#if bill.reference}
            <dt class="text-muted-foreground">Reference</dt>
            <dd class="font-mono break-all">
              {formatReference(bill.reference)}
              {#if bill.referenceType}
                <span class="text-muted-foreground">
                  ({bill.referenceType})</span
                >
              {/if}
            </dd>
          {/if}
          {#if bill.message}
            <dt class="text-muted-foreground">Message</dt>
            <dd class="break-words">{bill.message}</dd>
          {/if}
          {#if bill.issueDate}
            <dt class="text-muted-foreground">Issued</dt>
            <dd>{formatDate(bill.issueDate)}</dd>
          {/if}
          {#if expectedAccount}
            <dt class="text-muted-foreground">Pays from</dt>
            <dd>{expectedAccount}</dd>
          {/if}
          {#if bill.taxYear}
            <dt class="text-muted-foreground">Tax year</dt>
            <dd class="tabular-nums">{bill.taxYear}</dd>
          {/if}
          {#if bill.notes}
            <dt class="text-muted-foreground">Notes</dt>
            <dd class="break-words whitespace-pre-line">{bill.notes}</dd>
          {/if}
          {#if externalUrl}
            <dt class="text-muted-foreground">Source</dt>
            <dd>
              <a
                href={externalUrl}
                target="_blank"
                rel="external noopener noreferrer"
                class="inline-flex items-center gap-1 underline"
              >
                Open source document <ExternalLinkIcon class="size-3.5" />
              </a>
            </dd>
          {/if}
        </dl>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">Document</Card.Title>
    </Card.Header>
    <Card.Content class="grid gap-4">
      {#if data.document}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2 text-sm">
            <FileTextIcon class="text-muted-foreground size-4 shrink-0" />
            <span class="truncate">{data.document.fileName}</span>
            <span class="text-muted-foreground shrink-0 text-xs">
              {fileSize(data.document.size)}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            href={documentUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLinkIcon /> Open PDF
          </Button>
        </div>
        {#if mounted && desktop.current}
          {#key data.document.id}
            <iframe
              src={documentUrl}
              title="Bill PDF"
              class="bg-muted h-[70vh] w-full rounded-md border"
            ></iframe>
          {/key}
        {/if}
      {:else}
        <p class="text-muted-foreground text-sm">No PDF attached yet.</p>
      {/if}
      <DocumentUpload
        action="?/attachDocument"
        compact
        title={data.document
          ? "Replace the PDF: drop a file or click"
          : "Attach a PDF: drop a file or click"}
        hint="Up to 20 MB"
        pendingLabel="Uploading…"
        successMessage="PDF attached"
      />
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">Payments</Card.Title>
    </Card.Header>
    <Card.Content class="grid gap-5">
      {#if data.allocations.length > 0}
        <ul class="divide-y rounded-lg border">
          {#each data.allocations as allocation (allocation.id)}
            <AllocationRow {allocation} currency={bill.currency} />
          {/each}
        </ul>
      {:else}
        <p class="text-muted-foreground text-sm">
          No payments matched to this bill yet.
        </p>
      {/if}

      {#if data.suggestions.length > 0}
        <div class="grid gap-2">
          <h3 class="text-sm font-medium">Suggestions to confirm</h3>
          <ul class="divide-y rounded-lg border">
            {#each data.suggestions as suggestion (suggestion.transactionId)}
              <SuggestionCard
                {suggestion}
                showBill={false}
                includeBillId={false}
                confirmAction="?/allocate"
                dismissAction="?/dismissSuggestion"
              />
            {/each}
          </ul>
        </div>
      {/if}

      {#if data.dismissed.length > 0}
        <div class="grid gap-2">
          <h3 class="text-muted-foreground text-sm font-medium">
            Dismissed suggestions
          </h3>
          <ul class="divide-y rounded-lg border">
            {#each data.dismissed as transaction (transaction.id)}
              <DismissedRow {transaction} />
            {/each}
          </ul>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="text-base">Match a payment manually</Card.Title>
      <Card.Description>
        Pick a transaction and choose how much of it pays this bill. A negative
        amount records a refund.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      {#if candidatesCollapsed}
        <div
          class="text-muted-foreground flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3 text-sm"
        >
          <span>
            {bill.status === "cancelled"
              ? "This bill is cancelled."
              : "This bill is fully paid."}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() => (shownFor = bill.id)}>Show anyway</Button
          >
        </div>
      {:else}
        <form method="GET" class="flex gap-2" role="search">
          <Input
            name="q"
            type="search"
            value={data.candidateQuery}
            placeholder="Search counterparty, description, reference or amount"
            aria-label="Search transactions"
            autocomplete="off"
          />
          <Button type="submit" variant="outline">
            <SearchIcon /> Search
          </Button>
        </form>

        {#if data.candidates.items.length > 0}
          <ul class="divide-y rounded-lg border">
            {#each data.candidates.items as candidate (candidate.id)}
              <CandidateRow {candidate} currency={bill.currency} />
            {/each}
          </ul>
          {#if data.candidates.pageCount > 1}
            <nav
              class="flex items-center justify-between gap-2 text-sm"
              aria-label="Pages"
            >
              {#if data.candidates.page > 1}
                <Button
                  variant="outline"
                  size="sm"
                  href={pageHref(data.candidates.page - 1)}>Previous</Button
                >
              {:else}
                <span></span>
              {/if}
              <span class="text-muted-foreground tabular-nums">
                Page {data.candidates.page} of {data.candidates.pageCount}
              </span>
              {#if data.candidates.page < data.candidates.pageCount}
                <Button
                  variant="outline"
                  size="sm"
                  href={pageHref(data.candidates.page + 1)}>Next</Button
                >
              {:else}
                <span></span>
              {/if}
            </nav>
          {/if}
        {:else}
          <p
            class="text-muted-foreground rounded-md border border-dashed p-3 text-sm"
          >
            {#if data.candidateQuery}
              No transactions match "{data.candidateQuery}".
            {:else}
              No unmatched {bill.currency} transactions to offer for this bill.
            {/if}
          </p>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<Dialog.Root bind:open={editOpen}>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Edit bill</Dialog.Title>
      <Dialog.Description>
        {#if reviewDraft}
          Values read from the PDF again. Nothing is saved until you press Save.
        {:else}
          Change how this bill is described.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    {#if reviewDraft}
      <Alert.Root>
        <RefreshCwIcon />
        <Alert.Description>
          Review the values below. Fields the PDF did not provide keep their
          current values.
        </Alert.Description>
      </Alert.Root>
    {/if}
    {#key editKey}
      <BillForm
        action="?/update"
        values={formValues}
        accounts={data.accounts}
        submitLabel="Save"
        successMessage="Bill updated"
        lockKindAndCurrency={bill.allocationCount > 0}
        onSuccess={() => (editOpen = false)}
        onCancel={() => (editOpen = false)}
      />
    {/key}
  </Dialog.Content>
</Dialog.Root>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete this bill?"
  description="The bill and its matched payments are removed. The transactions themselves stay in your accounts. An uploaded PDF is deleted with it."
  action="?/delete"
  successMessage="Bill deleted"
/>
