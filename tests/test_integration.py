"""集成测试：验证完整工作流（mock LLM调用）"""

import json
import pytest
from unittest.mock import MagicMock


from agent.config import AgentConfig
from agent.input_loader import InputLoader
from agent.requirement_analyzer import RequirementAnalyzer
from agent.diagram_generator import DiagramGenerator
from agent.mermaid_validator import MermaidValidator
from agent.review_agent import ReviewAgent
from agent.output_manager import OutputManager
from agent.output_manager import _sanitize_filename

SAMPLE_REQUIREMENT = """# 简单计算器系统
## 用户角色
- 普通用户：使用计算器进行基本运算
## 功能需求
1. 加法运算：用户输入两个数字，系统返回它们的和
2. 减法运算：用户输入两个数字，系统返回它们的差
"""

MOCK_REQUIREMENT_JSON = {
    "project_name": "简单计算器",
    "project_overview": "一个简单的计算器系统",
    "actors": [{"name": "普通用户", "description": "使用计算器"}],
    "functions": [
        {"id": "F001", "name": "加法运算", "description": "求和", "related_actors": ["普通用户"], "priority": "高"},
        {"id": "F002", "name": "减法运算", "description": "求差", "related_actors": ["普通用户"], "priority": "高"},
    ],
    "entities": [{"name": "计算器", "description": "计算工具", "attributes": ["操作数", "运算符"]}],
    "constraints": [],
    "exceptions": [],
    "non_functional_requirements": [],
    "business_processes": [],
}

MOCK_DESIGN_TEXT = """# 系统设计
## 模块划分
- 计算模块：处理加减乘除运算
## 核心类
- Calculator：执行计算操作
"""

MOCK_CLASS_DIAGRAM = """classDiagram
    class 计算器 {
        -double 操作数1
        -double 操作数2
        +加法() double
        +减法() double
    }
"""

MOCK_ACTIVITY_DIAGRAM = """flowchart TD
    A([开始]) --> B[输入两个数字]
    B --> C[选择运算类型]
    C --> D[执行计算]
    D --> E[显示结果]
    E --> F([结束])
"""

MOCK_STATE_DIAGRAM = """stateDiagram-v2
    [*] --> 空闲
    空闲 --> 计算中 : 输入数据
    计算中 --> 显示结果 : 计算完成
    显示结果 --> 空闲 : 重置
    空闲 --> [*]
"""

MOCK_TEST_CASES = """# 测试用例

| 编号 | 描述 | 输入 | 预期结果 | 类型 |
|------|------|------|----------|------|
| TC001 | 加法正常 | 2, 3 | 5 | 正常 |
| TC002 | 减法正常 | 5, 3 | 2 | 正常 |
"""


class TestIntegrationWorkflow:
    """集成测试：验证各模块协作"""

    def test_input_loader(self, tmp_path):
        """测试输入加载"""
        req_file = tmp_path / "test_req.md"
        req_file.write_text(SAMPLE_REQUIREMENT)
        loader = InputLoader()
        text = loader.load(str(req_file))
        assert "计算器" in text
        assert len(text) > 0

    def test_input_loader_file_size_guard(self, tmp_path):
        """测试文件大小限制"""
        big_file = tmp_path / "big.md"
        big_file.write_text("x" * (512 * 1024 + 1))
        loader = InputLoader()
        with pytest.raises(ValueError, match="文件过大"):
            loader.load(str(big_file))

    def test_input_loader_encoding_fallback(self, tmp_path):
        """测试编码容错"""
        gbk_file = tmp_path / "gbk.md"
        gbk_file.write_bytes("# 需求\n中文内容".encode("gbk"))
        loader = InputLoader()
        text = loader.load(str(gbk_file))
        assert "中文内容" in text

    def test_input_loader_split_sections_code_fence(self):
        """测试代码围栏内的#号不被当作标题"""
        loader = InputLoader()
        text = """# 标题一
内容1

```python
# 这是注释，不是标题
def foo():
    pass
```

# 标题二
内容2
"""
        sections = loader.split_sections(text)
        assert len(sections) == 2
        assert sections[0]["title"] == "标题一"
        assert sections[1]["title"] == "标题二"
        # 代码围栏内容应保留在段落中
        assert "```python" in sections[0]["content"]

    def test_diagram_generator_extract_mermaid(self):
        """测试Mermaid代码提取"""
        gen = DiagramGenerator.__new__(DiagramGenerator)

        # 从代码块中提取
        raw = '这是类图：\n```mermaid\nclassDiagram\n    class Foo\n```\n结束'
        assert gen._extract_mermaid(raw, "classDiagram").startswith("classDiagram")

        # 多个代码块时优先选含Mermaid关键字的
        raw = '说明：\n```python\nprint("hi")\n```\n类图：\n```mermaid\nclassDiagram\n    class Bar\n```'
        result = gen._extract_mermaid(raw, "classDiagram")
        assert "classDiagram" in result
        assert "print" not in result

        # 直接Mermaid代码（无代码块）
        raw = "flowchart TD\n    A --> B"
        assert gen._extract_mermaid(raw, "flowchart") == raw

        # graph关键字
        raw = "graph TD\n    A --> B"
        assert gen._extract_mermaid(raw, "flowchart") == raw

    def test_mermaid_validator(self):
        """测试Mermaid语法校验"""
        validator = MermaidValidator()
        valid, msg = validator.validate(MOCK_CLASS_DIAGRAM, "class_diagram")
        assert valid, f"类图校验失败: {msg}"

        valid, msg = validator.validate(MOCK_ACTIVITY_DIAGRAM, "activity_diagram")
        assert valid, f"活动图校验失败: {msg}"

        valid, msg = validator.validate(MOCK_STATE_DIAGRAM, "state_diagram")
        assert valid, f"状态图校验失败: {msg}"

    def test_mermaid_validator_inline_comment(self):
        """测试Mermaid行内注释处理"""
        validator = MermaidValidator()
        diagram_with_comment = """flowchart TD
    A([开始]) --> B[输入] %% 这是注释
    B --> C[处理]
    C --> D([结束])
"""
        valid, msg = validator.validate(diagram_with_comment, "activity_diagram")
        assert valid, f"带注释的流程图校验失败: {msg}"

    def test_mermaid_validator_comment_positions(self):
        """测试注释位置检测"""
        content = "line1\n%% comment\nline3 %% inline\nline4"
        positions = MermaidValidator._find_comment_positions(content)
        # 行首注释 %% comment 的位置
        assert 6 in positions   # '%%' 的第一个 %
        assert 9 in positions   # 'c' of 'comment'
        # 行内注释 %% inline 的位置
        assert 23 in positions  # '%%' 的第一个 %
        assert 26 in positions  # 'i' of 'inline'
        # 非注释位置
        assert 0 not in positions  # 'l' of 'line1'
        assert 16 not in positions  # 换行符

    def test_output_manager(self, tmp_path):
        """测试输出管理"""
        manager = OutputManager(str(tmp_path))
        manager.save_requirement_analysis(MOCK_REQUIREMENT_JSON)
        manager.save_system_design(MOCK_DESIGN_TEXT)
        manager.save_diagrams({
            "class_diagram": MOCK_CLASS_DIAGRAM,
            "activity_diagram": MOCK_ACTIVITY_DIAGRAM,
            "state_diagram": MOCK_STATE_DIAGRAM,
        })
        manager.save_test_cases(MOCK_TEST_CASES)

        # 验证文件生成
        assert (tmp_path / "requirement_analysis.json").exists()
        assert (tmp_path / "requirement_analysis.md").exists()
        assert (tmp_path / "system_design.md").exists()
        assert (tmp_path / "class_diagram.mmd").exists()
        assert (tmp_path / "activity_diagram.mmd").exists()
        assert (tmp_path / "state_diagram.mmd").exists()
        assert (tmp_path / "test_cases.md").exists()

    def test_output_manager_json_roundtrip(self, tmp_path):
        """测试JSON输出可正确读回"""
        manager = OutputManager(str(tmp_path))
        manager.save_requirement_analysis(MOCK_REQUIREMENT_JSON)

        with open(tmp_path / "requirement_analysis.json", "r", encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded["project_name"] == "简单计算器"
        assert len(loaded["functions"]) == 2
        assert loaded["functions"][0]["id"] == "F001"

    def test_review_agent_syntax_validation(self):
        """测试审查Agent语法校验"""
        mock_llm = MagicMock()
        agent = ReviewAgent(mock_llm)
        results = agent.validate_mermaid_syntax({
            "class_diagram": MOCK_CLASS_DIAGRAM,
            "activity_diagram": MOCK_ACTIVITY_DIAGRAM,
            "state_diagram": MOCK_STATE_DIAGRAM,
        })
        assert all(r["valid"] for r in results)
        assert len(results) == 3

    def test_review_agent_detects_invalid_diagram(self):
        """测试审查Agent检测无效图"""
        mock_llm = MagicMock()
        agent = ReviewAgent(mock_llm)
        invalid_diagram = "this is not valid mermaid"
        results = agent.validate_mermaid_syntax({
            "class_diagram": invalid_diagram,
        })
        assert not results[0]["valid"]

    def test_requirement_analyzer_retry(self):
        """测试需求分析重试机制"""
        mock_llm = MagicMock()
        mock_llm.generate_json.side_effect = [
            json.JSONDecodeError("test", "", 0),
            MOCK_REQUIREMENT_JSON,
        ]
        analyzer = RequirementAnalyzer(mock_llm)
        result = analyzer.analyze("test requirement")
        assert result["project_name"] == "简单计算器"
        assert mock_llm.generate_json.call_count == 2

    def test_requirement_analyzer_validate(self):
        """测试需求分析结果验证"""
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        warnings = analyzer.validate_result(MOCK_REQUIREMENT_JSON)
        assert len(warnings) == 0

    def test_requirement_analyzer_validate_missing_fields(self):
        """测试需求分析缺失字段检测"""
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        incomplete = {"actors": [], "functions": []}  # 缺少 entities
        warnings = analyzer.validate_result(incomplete)
        assert any("entities" in w for w in warnings)

    def test_llm_client_json_extraction(self):
        """测试LLM客户端JSON提取"""
        from agent.llm_client import LLMClient
        mock_config = AgentConfig()
        mock_config.llm.provider = "openai"
        mock_config.llm.api_key = "test"
        client = LLMClient.__new__(LLMClient)

        # 测试从代码块提取
        raw = '```json\n{"key": "value"}\n```'
        result = client._extract_json_text(raw)
        assert result == '{"key": "value"}'

        # 测试从混合文本提取
        raw = 'Here is the result:\n{"key": "value"}\nDone.'
        result = client._extract_json_text(raw)
        assert result == '{"key": "value"}'

    def test_llm_client_json_completion(self):
        """测试LLM客户端截断JSON补全"""
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)

        # 测试截断的JSON补全
        truncated = '{"name": "test", "items": [1, 2'
        completed = client._try_complete_json(truncated)
        parsed = json.loads(completed)
        assert parsed["name"] == "test"
        assert parsed["items"] == [1, 2]

    def test_scorer_entity_matching(self):
        """测试评分器实体模糊匹配"""
        from benchmark.scorer import _fuzzy_match_entity

        # 直接匹配
        assert _fuzzy_match_entity("图书", "图书信息")
        # 中英文匹配
        assert _fuzzy_match_entity("图书", "Book")
        assert _fuzzy_match_entity("员工", "Employee")
        # 不匹配
        assert not _fuzzy_match_entity("图书", "课程")

    def test_scorer_function_matching(self):
        """测试评分器功能模糊匹配"""
        from benchmark.scorer import _fuzzy_match_function

        result_funcs = ["用户注册与登录", "图书搜索", "图书借阅"]
        result_text = " ".join(result_funcs)

        # 直接匹配
        assert _fuzzy_match_function("图书搜索", result_funcs, result_text)
        # 关键词匹配："用户登录" 在 "用户注册与登录" 中
        assert _fuzzy_match_function("用户登录", result_funcs, result_text)
        # 同义词匹配
        assert _fuzzy_match_function("登录", result_funcs, result_text)
        assert _fuzzy_match_function("注册", result_funcs, result_text)
        # 不匹配
        assert not _fuzzy_match_function("成绩录入", result_funcs, result_text)

    def test_input_loader_empty_file(self, tmp_path):
        """测试空文件处理"""
        empty_file = tmp_path / "empty.md"
        empty_file.write_text("")
        loader = InputLoader()
        with pytest.raises(ValueError, match="为空"):
            loader.load(str(empty_file))

    def test_input_loader_unsupported_extension(self, tmp_path):
        """测试不支持的文件扩展名"""
        bad_file = tmp_path / "test.xyz"
        bad_file.write_text("content")
        loader = InputLoader()
        with pytest.raises(ValueError, match="不支持"):
            loader.load(str(bad_file))

    def test_input_loader_file_too_large(self, tmp_path):
        """测试文件超过大小限制"""
        large_file = tmp_path / "large.md"
        large_file.write_text("x" * (512 * 1024 + 1))
        loader = InputLoader()
        with pytest.raises(ValueError, match="过大"):
            loader.load(str(large_file))

    def test_input_loader_gbk_encoding(self, tmp_path):
        """测试GBK编码文件"""
        gbk_file = tmp_path / "gbk.md"
        gbk_file.write_text("# 需求文档\n\n用户登录功能", encoding="gbk")
        loader = InputLoader()
        result = loader.load(str(gbk_file))
        assert "用户登录" in result

    def test_input_loader_json_with_content_field(self, tmp_path):
        """测试JSON格式输入（含content字段）"""
        json_file = tmp_path / "req.json"
        json_file.write_text('{"content": "用户注册需求"}', encoding="utf-8")
        loader = InputLoader()
        result = loader.load(str(json_file))
        assert "用户注册" in result

    def test_input_loader_split_sections(self):
        """测试文档分段"""
        loader = InputLoader()
        text = "# 第一章\n内容1\n# 第二章\n内容2"
        sections = loader.split_sections(text)
        assert len(sections) == 2
        assert sections[0]["title"] == "第一章"
        assert sections[1]["title"] == "第二章"

    def test_input_loader_split_sections_code_fence_simple(self):
        """测试代码块内的#不分段（简版）"""
        loader = InputLoader()
        text = "# 标题\n```python\n# 注释\n```\n正文"
        sections = loader.split_sections(text)
        assert len(sections) == 1
        assert sections[0]["title"] == "标题"

    def test_sanitize_filename_path_traversal(self):
        """测试文件名路径穿越防护"""
        assert _sanitize_filename("../../etc/passwd") == "____etc_passwd"
        assert _sanitize_filename("../../../root") == "______root"
        assert _sanitize_filename("test/../../../etc/passwd") == "test_______etc_passwd"
        assert _sanitize_filename("normal_file.md") == "normal_file.md"

    def test_input_loader_binary_file_rejected(self, tmp_path):
        """测试二进制文件被拒绝"""
        bin_file = tmp_path / "test.md"
        # 写入大量非打印字符（>30%非打印字符）
        bin_file.write_bytes(bytes(range(32)) * 100 + b"some text" * 10)
        loader = InputLoader()
        with pytest.raises(ValueError, match="二进制"):
            loader.load(str(bin_file))

    def test_input_loader_text_with_newlines_accepted(self, tmp_path):
        """测试正常文本文件（含换行符）不被误判为二进制"""
        text_file = tmp_path / "test.md"
        # 正常文本，换行符不计入非打印字符
        text_file.write_text("# 需求文档\n\n功能1\n功能2\n功能3\n" * 10)
        loader = InputLoader()
        result = loader.load(str(text_file))
        assert "需求文档" in result

    def test_diagram_generator_prefers_last_mermaid_block(self):
        """测试多个Mermaid块时优先返回最后一个"""
        gen = DiagramGenerator.__new__(DiagramGenerator)
        # LLM先给出错误版本，然后修正
        raw = """这是类图：
```mermaid
classDiagram
    class A
```
修正后的版本：
```mermaid
classDiagram
    class B {
        +method()
    }
```"""
        result = gen._extract_mermaid(raw, "classDiagram")
        assert "class B" in result
        assert "method" in result

    def test_config_empty_yaml(self, tmp_path):
        """测试空YAML配置文件"""
        empty_yaml = tmp_path / "empty.yaml"
        empty_yaml.write_text("")
        config = AgentConfig.load_from_yaml(str(empty_yaml))
        assert config.llm.provider == "openai"  # 默认值

    def test_requirement_analyzer_normalize_result(self):
        """测试需求分析结果类型规范化"""
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        # LLM返回字符串而非数组
        result = {"actors": "none", "functions": "用户登录", "entities": []}
        normalized = analyzer._normalize_result(result)
        assert normalized["actors"] == []
        assert normalized["functions"] == ["用户登录"]
        assert normalized["entities"] == []

    def test_scorer_constraint_matching(self):
        """测试约束匹配"""
        from benchmark.scorer import _match_constraint_or_exception

        # 直接匹配
        assert _match_constraint_or_exception("库存不足不能下单", "库存不足时不允许下单")
        # 数字量词匹配
        assert _match_constraint_or_exception("30分钟未支付取消", "订单超时未支付（30分钟）自动取消")
        # 关键词多数匹配
        assert _match_constraint_or_exception("课程人数限制", "每门课程有最大选课人数限制")
        # 不匹配
        assert not _match_constraint_or_exception("完全无关的约束", "库存不足不能下单")


class TestPromptLoader:
    """测试共享Prompt加载器"""

    def test_load_existing_prompt(self):
        """测试加载已存在的prompt文件"""
        from agent.prompt_loader import load_prompt
        content = load_prompt("requirement_analysis.md")
        assert len(content) > 0
        assert "requirement" in content.lower() or "需求" in content

    def test_load_with_fallback(self):
        """测试文件不存在时使用fallback"""
        from agent.prompt_loader import load_prompt
        content = load_prompt("nonexistent_file.md", "fallback content")
        assert content == "fallback content"

    def test_load_default_fallback(self):
        """测试文件不存在且无fallback时返回空字符串"""
        from agent.prompt_loader import load_prompt
        content = load_prompt("nonexistent_file.md")
        assert content == ""

    def test_cache_hit(self):
        """测试缓存命中"""
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        content1 = load_prompt("requirement_analysis.md")
        content2 = load_prompt("requirement_analysis.md")
        assert content1 == content2

    def test_clear_cache(self):
        """测试清空缓存"""
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        content = load_prompt("requirement_analysis.md")
        assert len(content) > 0
        clear_cache()
        content2 = load_prompt("requirement_analysis.md")
        assert content == content2


class TestLLMClientValidation:
    """测试LLM客户端输入验证"""

    def test_chat_empty_messages(self):
        """测试空消息列表"""
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        with pytest.raises(ValueError, match="不能为空"):
            client.chat([])

    def test_chat_invalid_message_type(self):
        """测试消息类型错误"""
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        with pytest.raises(ValueError, match="必须是dict"):
            client.chat(["not a dict"])

    def test_chat_missing_role(self):
        """测试缺少role字段"""
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        with pytest.raises(ValueError, match="缺少.*role"):
            client.chat([{"content": "hello"}])

    def test_chat_missing_content(self):
        """测试缺少content字段"""
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        with pytest.raises(ValueError, match="缺少.*content"):
            client.chat([{"role": "user"}])


class TestParseJsonRobust:
    """测试_parse_json_robust的健壮性"""

    def test_trailing_comma(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        result = client._parse_json_robust('{"key": "value",}')
        assert result == {"key": "value"}

    def test_trailing_comma_array(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        # _parse_json_robust returns dict only; list input raises JSONDecodeError
        with pytest.raises(json.JSONDecodeError):
            client._parse_json_robust('[1, 2, 3,]')

    def test_line_comments(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        text = '// comment\n{"key": "value"}'
        result = client._parse_json_robust(text)
        assert result == {"key": "value"}

    def test_valid_json_passes_through(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        result = client._parse_json_robust('{"a": 1, "b": [2, 3]}')
        assert result == {"a": 1, "b": [2, 3]}

    def test_unparseable_raises(self):
        from agent.llm_client import LLMClient
        client = LLMClient.__new__(LLMClient)
        with pytest.raises(json.JSONDecodeError):
            client._parse_json_robust("not json at all")


class TestPromptLoaderCacheKey:
    """测试prompt_loader缓存key一致性"""

    def test_path_variant_cache_hit(self):
        """带路径前缀的文件名应命中缓存"""
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        content1 = load_prompt("requirement_analysis.md")
        # 使用不同路径格式访问同一文件
        content2 = load_prompt("./requirement_analysis.md")
        assert content1 == content2


class TestNoneInputGuards:
    """测试各Agent对None/空输入的防御"""

    def test_requirement_analyzer_none_input(self):
        from agent.requirement_analyzer import RequirementAnalyzer
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        with pytest.raises(ValueError, match="需求文本不能为空"):
            analyzer.analyze(None)

    def test_requirement_analyzer_empty_input(self):
        from agent.requirement_analyzer import RequirementAnalyzer
        mock_llm = MagicMock()
        analyzer = RequirementAnalyzer(mock_llm)
        with pytest.raises(ValueError, match="需求文本不能为空"):
            analyzer.analyze("")

    def test_design_planner_none_json(self):
        from agent.design_planner import DesignPlanner
        mock_llm = MagicMock()
        planner = DesignPlanner(mock_llm)
        with pytest.raises(ValueError, match="需求JSON不能为空"):
            planner.generate_design(None)

    def test_design_planner_validate_none_text(self):
        from agent.design_planner import DesignPlanner
        mock_llm = MagicMock()
        planner = DesignPlanner(mock_llm)
        warnings = planner.validate_design(None, {"functions": []})
        assert any("为空" in w for w in warnings)

    def test_design_planner_validate_none_json(self):
        from agent.design_planner import DesignPlanner
        mock_llm = MagicMock()
        planner = DesignPlanner(mock_llm)
        warnings = planner.validate_design("some text", None)
        assert any("为空" in w for w in warnings)

    def test_test_case_generator_none_json(self):
        from agent.test_case_generator import TestCaseGenerator
        mock_llm = MagicMock()
        gen = TestCaseGenerator(mock_llm)
        with pytest.raises(ValueError, match="需求JSON不能为空"):
            gen.generate(None, "design")

    def test_test_case_generator_none_design(self):
        """design_text为None时应转为空字符串"""
        from agent.test_case_generator import TestCaseGenerator
        mock_llm = MagicMock()
        mock_llm.generate_text.return_value = "test output"
        gen = TestCaseGenerator(mock_llm)
        # 不应抛出异常
        result = gen.generate({"functions": []}, None)
        assert result == "test output"

    def test_test_case_generator_validate_none_md(self):
        from agent.test_case_generator import TestCaseGenerator
        mock_llm = MagicMock()
        gen = TestCaseGenerator(mock_llm)
        warnings = gen.validate_test_cases(None, {"functions": []})
        assert any("为空" in w for w in warnings)

    def test_test_case_generator_validate_none_json(self):
        from agent.test_case_generator import TestCaseGenerator
        mock_llm = MagicMock()
        gen = TestCaseGenerator(mock_llm)
        warnings = gen.validate_test_cases("|a|b|", None)
        assert any("为空" in w for w in warnings)


class TestPromptLoaderEdgeCases:
    """测试prompt_loader边界情况"""

    def test_empty_filename_returns_fallback(self):
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        result = load_prompt("", fallback="default")
        assert result == "default"

    def test_dot_filename_returns_fallback(self):
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        result = load_prompt(".", fallback="default")
        assert result == "default"

    def test_dotdot_filename_returns_fallback(self):
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        result = load_prompt("..", fallback="default")
        assert result == "default"

    def test_nonexistent_file_returns_fallback(self):
        from agent.prompt_loader import load_prompt, clear_cache
        clear_cache()
        result = load_prompt("nonexistent_template.md", fallback="default")
        assert result == "default"


class TestScorerEdgeCases:
    """测试scorer边界情况"""

    def test_score_diagram_syntax_none(self):
        from benchmark.scorer import score_diagram_syntax
        assert score_diagram_syntax(None) == 0.0

    def test_score_diagram_syntax_empty(self):
        from benchmark.scorer import score_diagram_syntax
        assert score_diagram_syntax({}) == 0.0

    def test_score_diagram_syntax_none_value(self):
        from benchmark.scorer import score_diagram_syntax
        result = score_diagram_syntax({"class_diagram": None})
        assert result == 0.0

    def test_score_requirement_coverage_none_result(self):
        from benchmark.scorer import score_requirement_coverage
        assert score_requirement_coverage(None, {"expected_actors": ["用户"]}) == 0.0

    def test_score_requirement_coverage_none_gold(self):
        from benchmark.scorer import score_requirement_coverage
        assert score_requirement_coverage({"actors": []}, None) == 0.0

    def test_score_entity_accuracy_none_inputs(self):
        from benchmark.scorer import score_entity_accuracy
        assert score_entity_accuracy(None, {}) == 0.0
        assert score_entity_accuracy({}, None) == 0.0

    def test_score_consistency_none_result(self):
        from benchmark.scorer import score_consistency
        assert score_consistency(None, {}) == 0.0

    def test_match_constraint_single_char_vacuous_truth(self):
        """单字符约束不应因all([])而返回True"""
        from benchmark.scorer import _match_constraint_or_exception
        # "X"不在target中，且长度为1无法生成2-gram
        assert _match_constraint_or_exception("X", "hello world") is False

    def test_compute_run_summary_none_scores(self):
        """scores为None时不应崩溃"""
        from benchmark.scorer import compute_run_summary
        results = [{"status": "success", "scores": None, "passed": True}]
        summary = compute_run_summary(results)
        assert summary["passed"] == 1

    def test_score_process_completeness_none_diagrams(self):
        from benchmark.scorer import score_process_completeness
        assert score_process_completeness(None, {"expected_processes": []}) == 0.0

    def test_score_process_completeness_none_gold(self):
        from benchmark.scorer import score_process_completeness
        assert score_process_completeness({"activity_diagram": "flowchart\nA-->B"}, None) >= 0

    def test_score_state_diagram_none_diagrams(self):
        from benchmark.scorer import score_state_diagram
        assert score_state_diagram(None, {"expected_processes": []}) == 0.0

    def test_score_state_diagram_none_gold(self):
        from benchmark.scorer import score_state_diagram
        assert score_state_diagram({"state_diagram": "stateDiagram-v2\n[*] --> A"}, None) >= 0

    def test_score_consistency_none_diagrams(self):
        from benchmark.scorer import score_consistency
        assert score_consistency({"entities": [{"name": "User"}]}, None) >= 0


class TestConsistencyCheckerEdgeCases:
    """测试consistency_checker边界情况"""

    def test_check_all_non_dict_requirement(self):
        from governance.consistency_checker import ConsistencyChecker
        checker = ConsistencyChecker()
        # 非dict的requirement_json不应崩溃
        result = checker.check_all("not a dict", "design", {}, "test")
        assert result.score >= 0

    def test_check_all_none_inputs(self):
        from governance.consistency_checker import ConsistencyChecker
        checker = ConsistencyChecker()
        result = checker.check_all(None, None, None, None)
        assert result.score >= 0


class TestMermaidValidatorEdgeCases:
    """测试Mermaid校验器边界情况"""

    def test_apostrophe_in_label(self):
        """单引号（撇号）不应导致括号校验失败"""
        from agent.mermaid_validator import MermaidValidator
        validator = MermaidValidator()
        content = '''classDiagram
    class User {
        +getUserName() string
    }
    class User's Profile {
        +getName() string
    }
    User --> User's Profile
'''
        is_valid, msg = validator.validate(content)
        # 不应因为撇号而报括号不匹配
        assert "括号" not in msg

    def test_empty_content(self):
        from agent.mermaid_validator import MermaidValidator
        validator = MermaidValidator()
        is_valid, msg = validator.validate("")
        assert not is_valid
        assert "空" in msg

    def test_none_content(self):
        from agent.mermaid_validator import MermaidValidator
        validator = MermaidValidator()
        is_valid, msg = validator.validate(None)
        assert not is_valid


class TestOutputManagerEdgeCases:
    """测试输出管理器边界情况"""

    def test_save_requirement_analysis_none(self, tmp_path):
        from agent.output_manager import OutputManager
        mgr = OutputManager(str(tmp_path))
        # None输入不应崩溃
        mgr.save_requirement_analysis(None)
        assert (tmp_path / "requirement_analysis.json").exists()

    def test_generate_summary_none_req(self, tmp_path):
        from agent.output_manager import OutputManager
        mgr = OutputManager(str(tmp_path))
        mgr._generate_summary(None)
        assert (tmp_path / "summary_report.md").exists()

    def test_write_file_atomic(self, tmp_path):
        """验证原子写入：文件内容完整"""
        from agent.output_manager import OutputManager
        mgr = OutputManager(str(tmp_path))
        content = "测试内容\n第二行\n"
        mgr._write_file("test.txt", content)
        assert (tmp_path / "test.txt").read_text(encoding="utf-8") == content

    def test_write_json_atomic(self, tmp_path):
        """验证原子写入JSON：文件内容完整"""
        from agent.output_manager import OutputManager
        mgr = OutputManager(str(tmp_path))
        data = {"key": "值", "nested": {"a": 1}}
        mgr._write_json("test.json", data)
        import json
        result = json.loads((tmp_path / "test.json").read_text(encoding="utf-8"))
        assert result == data


class TestTraceLoggerEdgeCases:
    """测试追踪日志边界情况"""

    def test_log_llm_call_none_result(self):
        from governance.trace_logger import TraceLogger
        trace = TraceLogger()
        # None result不应崩溃
        trace.log_llm_call("test", "chat", [{"role": "user", "content": "hi"}], None, 1.0)
        assert len(trace.entries) == 1

    def test_log_llm_call_empty_messages(self):
        from governance.trace_logger import TraceLogger
        trace = TraceLogger()
        trace.log_llm_call("test", "chat", [], "result", 0.5)
        assert len(trace.entries) == 1


class TestRepairControllerEdgeCases:
    """测试修复控制器边界情况"""

    def test_max_rounds_zero_skips_repair(self):
        from governance.repair_controller import RepairController
        from governance.models import ValidationResult
        controller = RepairController(max_rounds=0)
        output, records = controller.attempt_repair(
            "test", "original",
            lambda o: ValidationResult(is_valid=False, errors=["err"]),
            lambda o, e: "repaired"
        )
        assert output == "original"
        assert records == []

    def test_max_rounds_negative_skips_repair(self):
        from governance.repair_controller import RepairController
        from governance.models import ValidationResult
        controller = RepairController(max_rounds=-1)
        output, records = controller.attempt_repair(
            "test", "original",
            lambda o: ValidationResult(is_valid=False, errors=["err"]),
            lambda o, e: "repaired"
        )
        assert output == "original"
        assert records == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
