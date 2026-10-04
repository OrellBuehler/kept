import { describe, expect, it } from "vitest";
import { failureMessage, foldErrors } from "./form-submit";

describe("foldErrors", () => {
  it("returns errors unchanged without knownFields", () => {
    const errors = { name: ["Required."], other: ["Nope."] };
    expect(foldErrors(errors, undefined)).toEqual(errors);
  });

  it("keeps errors for rendered fields", () => {
    expect(foldErrors({ name: ["Required."] }, ["name"])).toEqual({
      name: ["Required."],
    });
  });

  it("folds unknown keys into form after existing form errors", () => {
    expect(
      foldErrors(
        {
          name: ["Required."],
          sortOrder: ["Enter a whole number."],
          form: ["Failed."],
        },
        ["name"],
      ),
    ).toEqual({
      name: ["Required."],
      form: ["Failed.", "Enter a whole number."],
    });
  });

  it("does not duplicate messages", () => {
    expect(foldErrors({ a: ["Same."], form: ["Same."] }, [])).toEqual({
      form: ["Same."],
    });
  });

  it("returns an empty object for no errors", () => {
    expect(foldErrors({}, ["name"])).toEqual({});
  });
});

describe("failureMessage", () => {
  it("uses the first error of a failed action", () => {
    expect(
      failureMessage({
        type: "failure",
        data: { errors: { categoryId: ["Pick a category."], form: ["x"] } },
      }),
    ).toBe("Pick a category.");
  });

  it("falls back for errors, redirects and empty failures", () => {
    expect(failureMessage({ type: "error" }, "Try again.")).toBe("Try again.");
    expect(
      failureMessage({ type: "failure", data: { errors: {} } }, "Fb"),
    ).toBe("Fb");
    expect(failureMessage({ type: "failure" })).toMatch(/went wrong/);
  });
});
