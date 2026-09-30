export const SECRET_HEADER_NAME = "X-Kept-Secret";
export const WEBHOOK_PATH_PREFIX = "/api/public/paperless/";

export function webhookUrl(origin: string, webhookToken: string): string {
  return `${origin.replace(/\/+$/, "")}${WEBHOOK_PATH_PREFIX}${webhookToken}`;
}

export interface WorkflowRecipe {
  title: string;
  /** Ordered instructions for the Paperless web UI (Workflows). */
  steps: string[];
  trigger: { type: "Document Added"; filterTag: string | null };
  action: {
    type: "Webhook";
    method: "POST";
    url: string;
    useParams: true;
    asJson: true;
    params: { document_id: string };
    headers: Record<string, string>;
    includeDocument: false;
  };
  notes: string[];
}

/**
 * The exact Paperless workflow to create so new documents reach Kept at once.
 * The secret is only known right after creating or rotating it; otherwise a
 * placeholder is shown.
 */
export function workflowRecipe(input: {
  origin: string;
  webhookToken: string;
  tagName?: string | null;
  secret?: string | null;
}): WorkflowRecipe {
  const url = webhookUrl(input.origin, input.webhookToken);
  const tag = input.tagName ?? null;
  const secret = input.secret ?? "<your webhook secret>";
  return {
    title: "Paperless workflow for instant import",
    steps: [
      "In Paperless open Workflows and add a new workflow.",
      `Add a trigger of type Document Added${tag ? ` and, under Filters, require the tag "${tag}"` : " (optionally filtered to your bill tag)"}.`,
      "Add an action of type Webhook.",
      `Set the URL to ${url}`,
      "Turn on Use parameters and Send webhook payload as JSON.",
      "Add the parameter document_id with the value {{ doc_id }}.",
      `Add the header ${SECRET_HEADER_NAME} with the webhook secret.`,
      "Leave Include document off. Save the workflow.",
    ],
    trigger: { type: "Document Added", filterTag: tag },
    action: {
      type: "Webhook",
      method: "POST",
      url,
      useParams: true,
      asJson: true,
      params: { document_id: "{{ doc_id }}" },
      headers: { [SECRET_HEADER_NAME]: secret },
      includeDocument: false,
    },
    notes: [
      "The address in the URL must be reachable from the Paperless server; replace the host if Kept is known under another name there.",
      "{{ doc_id }} is available for Document Added triggers. PAPERLESS_URL is only needed for {{ doc_url }}, not for {{ doc_id }}.",
      "If Paperless runs with PAPERLESS_WEBHOOKS_ALLOW_INTERNAL_REQUESTS=false it refuses to call private addresses. Allow internal requests or publish Kept at a public address.",
      "Paperless may send the webhook before the document is visible; Kept retries a few times automatically.",
      "Without the workflow Kept still checks for new documents every 30 minutes and on Sync now.",
      "Do not use a Document Updated trigger for this: Kept's own changes to custom fields would trigger it again.",
      "The secret is stored in plain text in Paperless and visible to users who can view workflows. Kept stores only a hash and shows the secret once.",
    ],
  };
}
