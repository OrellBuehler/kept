<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import type { CsvMappingProfileInput } from "$lib/server/importers/mapping";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { NativeSelect } from "$lib/components/ui/native-select";
  import { Spinner } from "$lib/components/ui/spinner";
  import { Switch } from "$lib/components/ui/switch";
  import * as Table from "$lib/components/ui/table";
  import Amount from "$lib/components/Amount.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import ColumnSelect from "$lib/components/import/ColumnSelect.svelte";
  import ImportSteps from "$lib/components/import/ImportSteps.svelte";

  import { submitHandler } from "$lib/form-submit";
  import { DATE_FORMATS, DELIMITERS, ENCODINGS } from "$lib/import-constants";
  import { FORMAT_LABELS, plural } from "$lib/import-ui";
  import type { PageProps } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let { data, form }: PageProps = $props();

  type Mode = NonNullable<CsvMappingProfileInput["amountMode"]>;
  type Managed =
    | "bookingDate"
    | "valueDate"
    | "amount"
    | "credit"
    | "debit"
    | "indicator"
    | "currency"
    | "counterpartyName"
    | "counterpartyIban"
    | "reference"
    | "externalId"
    | "balance";
  const MANAGED: Managed[] = [
    "bookingDate",
    "valueDate",
    "amount",
    "credit",
    "debit",
    "indicator",
    "currency",
    "counterpartyName",
    "counterpartyIban",
    "reference",
    "externalId",
    "balance",
  ];

  const DELIMITER_LABELS: Record<(typeof DELIMITERS)[number], string> = {
    auto: "Detect automatically",
    ",": "Comma ( , )",
    ";": "Semicolon ( ; )",
    "\t": "Tab",
    "|": "Pipe ( | )",
  };
  const ENCODING_LABELS: Record<(typeof ENCODINGS)[number], string> = {
    auto: "Detect automatically",
    "utf-8": "UTF-8",
    "utf-16le": "UTF-16 LE",
    "windows-1252": "Windows-1252",
    "iso-8859-1": "ISO-8859-1",
  };
  const THOUSANDS = [
    ["", "None"],
    ["'", "Apostrophe ( ' )"],
    [",", "Comma ( , )"],
    [".", "Period ( . )"],
    [" ", "Space"],
  ] as const;
  const MODES: [Mode, string][] = [
    ["single", "One amount column (signed)"],
    ["single_with_indicator", "Amount + credit/debit column"],
    ["split", "Separate credit and debit columns"],
  ];
  const DEFAULT_CREDIT = ["CRDT", "Credit", "CR", "C"];
  const DEFAULT_DEBIT = ["DBIT", "Debit", "DR", "D"];

  // The draft only supplies the initial state; later edits live in `ui`.
  const base = untrack(() =>
    $state.snapshot(data.draft),
  ) as CsvMappingProfileInput;
  const baseColumns = (base.columns ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const asList = (v: unknown): string[] =>
    v === undefined || v === null || v === ""
      ? []
      : (Array.isArray(v) ? v : [v]).map(String);

  let ui = $state({
    delimiter: base.delimiter ?? "auto",
    encoding: base.encoding ?? "auto",
    headerRow: (base.headerRow ?? 1) as number | null,
    skipFooterRows: (base.skipFooterRows ?? 0) as number | null,
    dateFormat: base.dateFormat ?? "YYYY-MM-DD",
    decimalSeparator: base.decimalSeparator ?? ".",
    thousandsSeparator: base.thousandsSeparator ?? "",
    amountMode: base.amountMode,
    invertSign: base.invertSign ?? false,
    creditValues: (base.indicatorCreditValues ?? DEFAULT_CREDIT).join(", "),
    debitValues: (base.indicatorDebitValues ?? DEFAULT_DEBIT).join(", "),
    defaultCurrency: base.defaultCurrency ?? "",
    columns: Object.fromEntries(
      MANAGED.map((k) => [k, text(baseColumns[k])]),
    ) as Record<Managed, string>,
    description: asList(baseColumns.description),
  });

  const modeColumns: Record<Mode, Managed[]> = {
    single: ["amount"],
    single_with_indicator: ["amount", "indicator"],
    split: ["credit", "debit"],
  };
  const amountKeys: Managed[] = ["amount", "credit", "debit", "indicator"];

  const splitValues = (s: string) =>
    s
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter((v) => v !== "");

  function toDraft(): CsvMappingProfileInput {
    const columns: Record<string, unknown> = { ...baseColumns };
    for (const k of MANAGED) {
      const active =
        !amountKeys.includes(k) || modeColumns[ui.amountMode].includes(k);
      if (active && ui.columns[k] !== "") columns[k] = ui.columns[k];
      else delete columns[k];
    }
    if (ui.description.length > 0) columns.description = [...ui.description];
    else delete columns.description;

    const draft: Record<string, unknown> = {
      ...base,
      delimiter: ui.delimiter,
      encoding: ui.encoding,
      headerRow: ui.headerRow ?? 1,
      skipFooterRows: ui.skipFooterRows ?? 0,
      dateFormat: ui.dateFormat,
      decimalSeparator: ui.decimalSeparator,
      thousandsSeparator: ui.thousandsSeparator,
      amountMode: ui.amountMode,
      invertSign: ui.invertSign,
      columns,
    };
    const credit = splitValues(ui.creditValues);
    const debit = splitValues(ui.debitValues);
    if (ui.amountMode === "single_with_indicator") {
      if (credit.length > 0) draft.indicatorCreditValues = credit;
      else delete draft.indicatorCreditValues;
      if (debit.length > 0) draft.indicatorDebitValues = debit;
      else delete draft.indicatorDebitValues;
    } else {
      delete draft.indicatorCreditValues;
      delete draft.indicatorDebitValues;
    }
    if (ui.defaultCurrency.trim() !== "") {
      draft.defaultCurrency = ui.defaultCurrency.trim();
    } else {
      delete draft.defaultCurrency;
    }
    return draft as unknown as CsvMappingProfileInput;
  }

  const profileJson = $derived(JSON.stringify(toDraft()));

  let result = $state(untrack(() => data));
  let loading = $state(false);
  let previewError = $state<string | null>(null);
  let saving = $state(false);
  let saveErrors = $state<Record<string, string[]>>(
    untrack(() => form?.errors ?? {}),
  );
  let profileName = $state(
    untrack(
      () =>
        (form?.values?.name as string | undefined) ??
        data.savedName ??
        `${data.account.name} export`,
    ),
  );

  let lastSent = untrack(() => profileJson);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  async function refresh(json: string) {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const response = await fetch(
        resolve("/api/imports/[pendingId]/preview", {
          pendingId: data.pendingId,
        }),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `{"profile":${json}}`,
          signal: mine.signal,
        },
      );
      if (!response.ok) {
        previewError =
          response.status >= 500
            ? "The preview failed on the server. Try again in a moment."
            : `The preview request was rejected (${response.status}). Reload the page and try again.`;
        return;
      }
      let body: typeof result;
      try {
        body = await response.json();
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        console.error("mapping preview returned a non-JSON response", err);
        previewError =
          "The server sent an unexpected response. Reload the page and try again.";
        return;
      }
      result = body;
      previewError = null;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("mapping preview failed", err);
      previewError = "Could not reach the server. Check your connection.";
    } finally {
      if (controller === mine && json === lastSent) loading = false;
    }
  }

  $effect(() => {
    const json = profileJson;
    if (json === lastSent) return;
    lastSent = json;
    loading = true;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(json), 300);
  });

  $effect(() => () => {
    clearTimeout(timer);
    controller?.abort();
  });

  const byIndex = $derived(ui.headerRow === 0);
  const detected = $derived(result.detected);
  const colKey = (c: { index: number; name: string }) =>
    byIndex ? String(c.index) : c.name;
  const isXlsx = $derived(data.format === "xlsx");
  const modeCols = $derived(modeColumns[ui.amountMode]);
  const headerInvalid = $derived(
    ui.headerRow === null ||
      ui.headerRow < 0 ||
      !Number.isInteger(ui.headerRow),
  );
  const footerInvalid = $derived(
    ui.skipFooterRows === null ||
      ui.skipFooterRows < 0 ||
      !Number.isInteger(ui.skipFooterRows),
  );
  const valid = $derived(
    result.profile !== null &&
      !previewError &&
      !headerInvalid &&
      !footerInvalid,
  );
  const okRows = $derived(result.preview.filter((r) => r.transaction).length);
  const badRows = $derived(result.preview.filter((r) => r.error).length);

  function toggleDescription(name: string, on: boolean) {
    ui.description = on
      ? [...ui.description, name]
      : ui.description.filter((d) => d !== name);
  }
</script>

<svelte:head>
  <title>Map columns · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <div class="grid gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="text-2xl font-semibold tracking-tight md:text-3xl">
        Map columns
      </h1>
      <Badge variant="outline">{FORMAT_LABELS[data.format]}</Badge>
    </div>
    <p class="text-muted-foreground text-sm break-words">
      {data.fileName} · {data.account.name} ({data.account.currency}) · {plural(
        data.dataRowCount,
        "row",
      )}. The mapping is saved for this account and reused for future files.
    </p>
    <ImportSteps current={3} />
  </div>

  <div
    class="grid items-start gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]"
  >
    <div class="grid min-w-0 gap-4">
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">File layout</Card.Title>
        </Card.Header>
        <Card.Content class="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          {#if !isXlsx}
            <FormField label="Delimiter" for="m-delimiter">
              <NativeSelect
                id="m-delimiter"
                bind:value={ui.delimiter}
                class="w-full"
              >
                {#each DELIMITERS as value (value)}
                  <option {value}>{DELIMITER_LABELS[value]}</option>
                {/each}
              </NativeSelect>
            </FormField>
            <FormField label="Encoding" for="m-encoding">
              <NativeSelect
                id="m-encoding"
                bind:value={ui.encoding}
                class="w-full"
              >
                {#each ENCODINGS as value (value)}
                  <option {value}>{ENCODING_LABELS[value]}</option>
                {/each}
              </NativeSelect>
            </FormField>
          {/if}
          <FormField
            label="Header row"
            for="m-header"
            errors={headerInvalid
              ? ["Enter a whole number, 0 or more."]
              : undefined}
            hint="Line number of the column names. 0 = no header; columns are then numbered."
          >
            <Input
              id="m-header"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              bind:value={ui.headerRow}
            />
          </FormField>
          <FormField
            label="Footer rows to skip"
            for="m-footer"
            errors={footerInvalid
              ? ["Enter a whole number, 0 or more."]
              : undefined}
            hint="Trailing lines such as totals."
          >
            <Input
              id="m-footer"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              bind:value={ui.skipFooterRows}
            />
          </FormField>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">Dates, numbers, currency</Card.Title>
        </Card.Header>
        <Card.Content class="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <FormField label="Date format" for="m-date">
            <NativeSelect id="m-date" bind:value={ui.dateFormat} class="w-full">
              {#each DATE_FORMATS as value (value)}
                <option {value}>{value}</option>
              {/each}
            </NativeSelect>
          </FormField>
          <FormField label="Decimal separator" for="m-decimal">
            <NativeSelect
              id="m-decimal"
              bind:value={ui.decimalSeparator}
              class="w-full"
            >
              <option value=".">Period ( . )</option>
              <option value=",">Comma ( , )</option>
            </NativeSelect>
          </FormField>
          <FormField label="Thousands separator" for="m-thousands">
            <NativeSelect
              id="m-thousands"
              bind:value={ui.thousandsSeparator}
              class="w-full"
            >
              {#each THOUSANDS as [value, label] (value)}
                <option {value}>{label}</option>
              {/each}
            </NativeSelect>
          </FormField>
          <FormField
            label="Default currency"
            for="m-currency-default"
            hint="Used when there is no currency column or the cell is empty."
          >
            <Input
              id="m-currency-default"
              bind:value={ui.defaultCurrency}
              maxlength={3}
              autocomplete="off"
              class="uppercase"
              placeholder={data.account.currency}
            />
          </FormField>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">Amount</Card.Title>
        </Card.Header>
        <Card.Content class="grid gap-4">
          <FormField label="Amount layout" for="m-mode">
            <NativeSelect id="m-mode" bind:value={ui.amountMode} class="w-full">
              {#each MODES as [value, label] (value)}
                <option {value}>{label}</option>
              {/each}
            </NativeSelect>
          </FormField>
          {#if modeCols.includes("amount")}
            <ColumnSelect
              id="m-amount"
              label="Amount column"
              bind:value={ui.columns.amount}
              {detected}
              {byIndex}
              required
            />
          {/if}
          {#if modeCols.includes("indicator")}
            <ColumnSelect
              id="m-indicator"
              label="Credit/debit column"
              bind:value={ui.columns.indicator}
              {detected}
              {byIndex}
              required
            />
            <FormField
              label="Values meaning credit"
              for="m-credit-values"
              hint="Comma separated, case-insensitive."
            >
              <Input id="m-credit-values" bind:value={ui.creditValues} />
            </FormField>
            <FormField
              label="Values meaning debit"
              for="m-debit-values"
              hint="Comma separated, case-insensitive."
            >
              <Input id="m-debit-values" bind:value={ui.debitValues} />
            </FormField>
          {/if}
          {#if modeCols.includes("credit")}
            <ColumnSelect
              id="m-credit"
              label="Credit column"
              bind:value={ui.columns.credit}
              {detected}
              {byIndex}
            />
            <ColumnSelect
              id="m-debit"
              label="Debit column"
              bind:value={ui.columns.debit}
              {detected}
              {byIndex}
            />
          {/if}
          <div class="flex items-center justify-between gap-3">
            <Label for="m-invert">
              Invert sign
              <span class="text-muted-foreground font-normal">
                (debits are positive in the file)
              </span>
            </Label>
            <Switch id="m-invert" bind:checked={ui.invertSign} />
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">Columns</Card.Title>
        </Card.Header>
        <Card.Content class="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <ColumnSelect
            id="m-booking"
            label="Booking date"
            bind:value={ui.columns.bookingDate}
            {detected}
            {byIndex}
            required
          />
          <ColumnSelect
            id="m-value"
            label="Value date"
            bind:value={ui.columns.valueDate}
            {detected}
            {byIndex}
          />
          <ColumnSelect
            id="m-currency"
            label="Currency"
            bind:value={ui.columns.currency}
            {detected}
            {byIndex}
          />
          <ColumnSelect
            id="m-name"
            label="Counterparty name"
            bind:value={ui.columns.counterpartyName}
            {detected}
            {byIndex}
          />
          <ColumnSelect
            id="m-iban"
            label="Counterparty IBAN"
            bind:value={ui.columns.counterpartyIban}
            {detected}
            {byIndex}
          />
          <ColumnSelect
            id="m-reference"
            label="Payment reference"
            bind:value={ui.columns.reference}
            {detected}
            {byIndex}
          />
          <ColumnSelect
            id="m-external"
            label="Bank reference (unique id)"
            bind:value={ui.columns.externalId}
            {detected}
            {byIndex}
          />
          <ColumnSelect
            id="m-balance"
            label="Balance after booking"
            bind:value={ui.columns.balance}
            {detected}
            {byIndex}
          />
          <fieldset
            class="grid content-start gap-1.5 sm:col-span-2 lg:col-span-1"
          >
            <legend class="text-sm leading-none font-medium">
              Description
            </legend>
            <p class="text-muted-foreground text-xs">
              Tick several columns to join them into one text.
            </p>
            <div
              class="mt-1 grid max-h-44 gap-2 overflow-y-auto rounded-md border p-3"
            >
              {#each detected as column (column.index)}
                {@const id = `m-desc-${column.index}`}
                <div class="flex items-center gap-2">
                  <Checkbox
                    {id}
                    checked={ui.description.includes(colKey(column))}
                    onCheckedChange={(v) =>
                      toggleDescription(colKey(column), v === true)}
                  />
                  <Label for={id} class="min-w-0 break-words">
                    {column.name || `Column ${column.index + 1}`}
                  </Label>
                </div>
              {:else}
                <span class="text-muted-foreground text-sm">
                  No columns detected.
                </span>
              {/each}
            </div>
          </fieldset>
        </Card.Content>
      </Card.Root>
    </div>

    <div
      class="grid min-w-0 gap-4 lg:sticky lg:top-16 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto"
    >
      {#if previewError}
        <Alert.Root variant="destructive" class="border-destructive/40">
          <CircleAlertIcon />
          <Alert.Title>Preview unavailable</Alert.Title>
          <Alert.Description>{previewError}</Alert.Description>
        </Alert.Root>
      {/if}
      {#if result.errors.length > 0}
        <Alert.Root variant="destructive" class="border-destructive/40">
          <CircleAlertIcon />
          <Alert.Title>This mapping is not valid yet</Alert.Title>
          <Alert.Description>
            <ul class="list-disc ps-4">
              {#each result.errors as message (message)}
                <li class="break-words">{message}</li>
              {/each}
            </ul>
          </Alert.Description>
        </Alert.Root>
      {/if}

      <Card.Root class="min-w-0" aria-live="polite" aria-busy={loading}>
        <Card.Header>
          <Card.Title class="flex items-center gap-2 text-base">
            Preview
            {#if loading}<Spinner
                class="size-4"
                aria-label="Updating preview"
              />{/if}
          </Card.Title>
          <Card.Description>
            {#if result.profile}
              {okRows} of the first {result.preview.length} rows read{badRows >
              0
                ? `, ${badRows} with problems`
                : ""}.
            {:else}
              Choose the columns to see how rows are read.
            {/if}
          </Card.Description>
        </Card.Header>
        <Card.Content class="min-w-0">
          {#if result.preview.length === 0}
            <p
              class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
            >
              No rows to preview yet.
            </p>
          {:else}
            <div class="max-h-96 overflow-auto rounded-lg border">
              <Table.Root>
                <Table.Header class="bg-muted/50 sticky top-0">
                  <Table.Row>
                    <Table.Head class="w-12 text-end">#</Table.Head>
                    <Table.Head>Date</Table.Head>
                    <Table.Head class="text-end">Amount</Table.Head>
                    <Table.Head>Counterparty</Table.Head>
                    <Table.Head>Description</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each result.preview as row (row.rowNumber)}
                    {@const tx = row.transaction}
                    <Table.Row
                      class={row.error ? "bg-destructive/10" : undefined}
                    >
                      <Table.Cell
                        class="text-muted-foreground text-end tabular-nums"
                      >
                        {row.rowNumber}
                      </Table.Cell>
                      {#if tx}
                        <Table.Cell class="whitespace-nowrap">
                          {prefs.date(tx.bookingDate)}
                        </Table.Cell>
                        <Table.Cell class="text-end">
                          <Amount
                            value={tx.amount}
                            currency={tx.currency}
                            flow
                          />
                        </Table.Cell>
                        <Table.Cell class="max-w-48 truncate">
                          {tx.counterpartyName ?? "—"}
                        </Table.Cell>
                        <Table.Cell class="max-w-64 truncate">
                          {tx.description ?? "—"}
                        </Table.Cell>
                      {:else}
                        <Table.Cell
                          colspan={4}
                          class="text-destructive whitespace-normal"
                        >
                          {row.error ?? "Row could not be read."}
                        </Table.Cell>
                      {/if}
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>

      <Card.Root class="min-w-0">
        <Card.Header>
          <Card.Title class="text-base">File contents</Card.Title>
          <Card.Description>
            First {result.sampleRows.length} of {plural(
              result.rowCount,
              "line",
            )}
            as found in the file; the header row is highlighted.
          </Card.Description>
        </Card.Header>
        <Card.Content class="min-w-0">
          {#if result.sampleRows.length === 0}
            <p
              class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
            >
              The file has no readable rows.
            </p>
          {:else}
            <div class="max-h-80 overflow-auto rounded-lg border">
              <Table.Root class="text-xs">
                <Table.Body>
                  {#each result.sampleRows as cells, i (i)}
                    <Table.Row
                      class={i + 1 === ui.headerRow
                        ? "bg-primary/10 font-semibold"
                        : undefined}
                    >
                      <Table.Cell
                        class="text-muted-foreground text-end tabular-nums"
                      >
                        {i + 1}
                      </Table.Cell>
                      {#each cells as cell, j (j)}
                        <Table.Cell class="max-w-48 truncate">{cell}</Table.Cell
                        >
                      {/each}
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    </div>
  </div>

  <form
    method="POST"
    action="?/save"
    class="bg-background/95 sticky bottom-0 z-10 -mx-4 grid gap-2 border-t px-4 py-3 backdrop-blur md:-mx-6 md:px-6"
    use:enhance={submitHandler({
      setPending: (v) => (saving = v),
      setErrors: (e) => (saveErrors = e),
      knownFields: ["name", "profile"],
    })}
  >
    <input type="hidden" name="profile" value={profileJson} />
    {#each [...(saveErrors.form ?? []), ...(saveErrors.profile ?? [])] as message (message)}
      <p class="text-destructive text-sm" role="alert">{message}</p>
    {/each}
    <div class="flex flex-wrap items-end justify-between gap-3">
      <FormField
        label="Profile name"
        for="m-name-profile"
        errors={saveErrors.name}
        class="w-full sm:w-72"
      >
        <Input
          id="m-name-profile"
          name="name"
          bind:value={profileName}
          maxlength={80}
          required
          disabled={saving}
        />
      </FormField>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          href={resolve("/(app)/import")}
          disabled={saving}>Back</Button
        >
        <Button type="submit" disabled={saving || loading || !valid}>
          {#if saving}<Spinner />Saving…{:else}Save mapping and continue{/if}
        </Button>
      </div>
    </div>
  </form>
</div>
