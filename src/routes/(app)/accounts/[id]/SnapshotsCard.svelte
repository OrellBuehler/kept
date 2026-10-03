<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Table from "$lib/components/ui/table";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ScaleIcon from "@lucide/svelte/icons/scale";
  import type { PageData } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  type Snapshot = PageData["snapshots"][number];

  let { snapshots, currency }: { snapshots: Snapshot[]; currency: string } =
    $props();

  const uid = $props.id();
  let addOpen = $state(false);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let deleting = $state<Snapshot | null>(null);
  let deleteOpen = $state(false);

  $effect(() => {
    if (addOpen) errors = {};
  });

  function askDelete(s: Snapshot) {
    deleting = s;
    deleteOpen = true;
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Balance snapshots</Card.Title>
    <Card.Description>
      Use balance snapshots for accounts you don't import, e.g. pension or
      investment accounts.
    </Card.Description>
    <Card.Action>
      <Button size="sm" variant="outline" onclick={() => (addOpen = true)}>
        <PlusIcon /> Add snapshot
      </Button>
    </Card.Action>
  </Card.Header>
  <Card.Content>
    {#if snapshots.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><ScaleIcon /></Empty.Media>
          <Empty.Title>No balance snapshots</Empty.Title>
          <Empty.Description>
            Record the balance on a given day to track this account over time.
          </Empty.Description>
        </Empty.Header>
        <Empty.Content>
          <Button size="sm" onclick={() => (addOpen = true)}>
            <PlusIcon /> Add snapshot
          </Button>
        </Empty.Content>
      </Empty.Root>
    {:else}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Date</Table.Head>
            <Table.Head class="text-end">Balance</Table.Head>
            <Table.Head class="hidden sm:table-cell">Source</Table.Head>
            <Table.Head class="hidden sm:table-cell">Note</Table.Head>
            <Table.Head class="w-10"
              ><span class="sr-only">Actions</span></Table.Head
            >
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each snapshots as s (s.id)}
            <Table.Row>
              <Table.Cell class="whitespace-nowrap">
                {prefs.date(s.date)}
                <div class="text-muted-foreground text-xs sm:hidden">
                  {s.source === "manual" ? "manual" : "imported"}
                </div>
              </Table.Cell>
              <Table.Cell class="text-end">
                <Amount value={s.amount} {currency} />
              </Table.Cell>
              <Table.Cell class="hidden sm:table-cell">
                <Badge
                  variant={s.source === "manual" ? "secondary" : "outline"}
                >
                  {s.source === "manual" ? "manual" : "imported"}
                </Badge>
              </Table.Cell>
              <Table.Cell
                class="text-muted-foreground hidden max-w-64 truncate sm:table-cell"
              >
                {s.note ?? ""}
              </Table.Cell>
              <Table.Cell class="text-end">
                {#if s.source === "manual"}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete snapshot from {prefs.date(s.date)}"
                    onclick={() => askDelete(s)}
                  >
                    <Trash2Icon />
                  </Button>
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    {/if}
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={addOpen}>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Add balance snapshot</Dialog.Title>
      <Dialog.Description>
        The balance at the end of the chosen day.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/addSnapshot"
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["date", "amount", "note"],
        successMessage: "Snapshot added",
        onSuccess: () => (addOpen = false),
      })}
    >
      <FormField label="Date" for="{uid}-date" errors={errors.date}>
        <Input
          id="{uid}-date"
          name="date"
          type="date"
          required
          value={todayIso()}
          aria-invalid={!!errors.date}
        />
      </FormField>
      <FormField
        label="Balance ({currency})"
        for="{uid}-amount"
        errors={errors.amount}
        hint="Use a minus sign for a negative balance."
      >
        <Input
          id="{uid}-amount"
          name="amount"
          inputmode="decimal"
          autocomplete="off"
          required
          class="text-end tabular-nums"
          placeholder="0.00"
          aria-invalid={!!errors.amount}
        />
      </FormField>
      <FormField label="Note (optional)" for="{uid}-note" errors={errors.note}>
        <Input id="{uid}-note" name="note" maxlength={1000} />
      </FormField>
      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (addOpen = false)}
          disabled={pending}>Cancel</Button
        >
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />{/if}
          Add snapshot
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete this snapshot?"
  description="The balance recorded on {deleting
    ? prefs.date(deleting.date)
    : ''} will be removed. Your transactions are not affected."
  action="?/deleteSnapshot"
  fields={{ snapshotId: deleting?.id ?? "" }}
  successMessage="Snapshot deleted"
/>
