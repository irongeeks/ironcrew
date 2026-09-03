import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import MessageContent from "../MessageContent";

describe("MessageContent XSS protection", () => {
  it("renders http:// links as anchors", () => {
    const { container } = render(<MessageContent content="[click](http://example.com)" />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("http://example.com");
    expect(link?.textContent).toBe("click");
  });

  it("renders https:// links as anchors", () => {
    const { container } = render(<MessageContent content="[secure](https://example.com)" />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://example.com");
  });

  it("renders javascript:alert(1) as plain text (no anchor)", () => {
    const { container } = render(<MessageContent content="[xss](javascript:alert(1))" />);
    const link = container.querySelector("a");
    expect(link).toBeNull();
    // The link text should still appear as a span
    const span = container.querySelector("span.text-blue-400");
    expect(span?.textContent).toBe("xss");
  });

  it("renders data:text/html as plain text", () => {
    const { container } = render(<MessageContent content="[data](data:text/html,<script>alert(1)</script>)" />);
    const link = container.querySelector("a");
    expect(link).toBeNull();
  });

  it("renders vbscript: as plain text", () => {
    const { container } = render(<MessageContent content="[vb](vbscript:msgbox)" />);
    const link = container.querySelector("a");
    expect(link).toBeNull();
  });

  it("blocks protocol-relative // URLs (potential phishing vector)", () => {
    const { container } = render(<MessageContent content="[rel](//example.com/path)" />);
    const link = container.querySelector("a");
    expect(link).toBeNull();
  });

  it("renders mailto: as anchor", () => {
    const { container } = render(<MessageContent content="[email](mailto:test@example.com)" />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("mailto:test@example.com");
  });

  it("renders fragment # links as anchors", () => {
    const { container } = render(<MessageContent content="[section](#heading)" />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("#heading");
  });
});
