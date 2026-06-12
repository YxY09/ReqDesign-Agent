import { describe, it, expect } from "vitest";
import { parseXmlString } from "../src/xmlParser.js";

describe("parseXmlString", () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<req_document>
  <p>
    <title>功能概述</title>
    <text_body>系统应支持用户登录和注册功能。</text_body>
  </p>
  <p>
    <title>性能要求</title>
    <text_body>页面加载时间不超过 2 秒。</text_body>
  </p>
</req_document>`;

  it("解析两级标题和正文", () => {
    const result = parseXmlString(sampleXml);
    expect(result).toContain("# 功能概述");
    expect(result).toContain("系统应支持用户登录和注册功能");
    expect(result).toContain("# 性能要求");
    expect(result).toContain("页面加载时间不超过 2 秒");
  });

  it("解析嵌套 p 标签（深度标题）", () => {
    const nestedXml = `<req_document>
  <p>
    <title>模块A</title>
    <p>
      <title>子功能1</title>
      <text_body>子功能描述</text_body>
    </p>
  </p>
</req_document>`;
    const result = parseXmlString(nestedXml);
    expect(result).toContain("## 子功能1");
    expect(result).toContain("子功能描述");
  });

  it("空 XML 返回空字符串", () => {
    const result = parseXmlString("<req_document></req_document>");
    expect(result).toBe("");
  });

  it("无 text_body 的段落仍输出标题", () => {
    const xml = `<req_document>
  <p><title>仅标题</title></p>
</req_document>`;
    const result = parseXmlString(xml);
    expect(result).toContain("# 仅标题");
  });
});
