import { describe, expect, it } from "vitest";
import { webhookUrl, workflowRecipe } from "./setup";

describe("workflowRecipe", () => {
  it("describes the exact workflow", () => {
    const r = workflowRecipe({
      origin: "https://kept.example/",
      webhookToken: "tok123",
      tagName: "Bills",
      secret: "s3cret",
    });
    expect(r.trigger).toEqual({ type: "Document Added", filterTag: "Bills" });
    expect(r.action).toEqual({
      type: "Webhook",
      method: "POST",
      url: "https://kept.example/api/public/paperless/tok123",
      useParams: true,
      asJson: true,
      params: { document_id: "{{ doc_id }}" },
      headers: { "X-Kept-Secret": "s3cret" },
      includeDocument: false,
    });
    expect(r.steps.join("\n")).toContain(
      "https://kept.example/api/public/paperless/tok123",
    );
    const notes = r.notes.join("\n");
    expect(notes).toContain("PAPERLESS_URL");
    expect(notes).toContain("PAPERLESS_WEBHOOKS_ALLOW_INTERNAL_REQUESTS");
  });

  it("uses a placeholder when the secret is not known", () => {
    const r = workflowRecipe({
      origin: "http://kept.local:3000",
      webhookToken: "t",
    });
    expect(r.action.headers["X-Kept-Secret"]).toBe("<your webhook secret>");
    expect(r.trigger.filterTag).toBeNull();
    expect(webhookUrl("http://kept.local:3000", "t")).toBe(
      "http://kept.local:3000/api/public/paperless/t",
    );
  });
});
