"""Mermaid语法校验工具"""

import logging
import os
import re
import subprocess
import shutil

logger = logging.getLogger("reqdesign")


class MermaidValidator:
    """Mermaid语法校验器"""

    def __init__(self, use_cli: bool = False):
        """
        Args:
            use_cli: 是否使用mermaid-cli进行校验，False则使用正则校验
        """
        self.use_cli = use_cli and shutil.which("mmdc") is not None
        if use_cli and not self.use_cli:
            logger.warning("mermaid-cli (mmdc) 未安装，降级为正则校验")

    def validate(self, mmd_content: str, diagram_type: str = "") -> tuple[bool, str]:
        """
        校验Mermaid语法

        Args:
            mmd_content: Mermaid代码
            diagram_type: 图类型（classDiagram/flowchart/stateDiagram-v2）

        Returns:
            (is_valid, error_message)
        """
        if not mmd_content or not mmd_content.strip():
            return False, "Mermaid代码为空"

        content = mmd_content.strip()

        # 基础结构检查
        is_valid, msg = self._check_structure(content, diagram_type)
        if not is_valid:
            return False, msg

        # 括号匹配检查
        is_valid, msg = self._check_brackets(content)
        if not is_valid:
            return False, msg

        # 使用CLI校验（如果可用）
        if self.use_cli:
            return self._validate_with_cli(content)

        return True, "语法校验通过"

    def _check_structure(self, content: str, diagram_type: str) -> tuple[bool, str]:
        """检查基本结构"""
        # 检查图类型声明
        valid_headers = ["classDiagram", "flowchart", "graph", "stateDiagram-v2", "stateDiagram"]
        has_header = any(content.startswith(h) for h in valid_headers)
        if not has_header:
            return False, f"缺少图类型声明，应以 {valid_headers} 之一开头"

        # 检查是否有实际内容（不只是头部声明）
        lines = [l.strip() for l in content.split("\n") if l.strip() and not l.strip().startswith("%%")]
        if len(lines) < 2:
            return False, "图内容过少，只有头部声明没有实际内容"

        # classDiagram 特殊检查
        if content.startswith("classDiagram"):
            if "class " not in content:
                return False, "类图中缺少 class 定义"

        # flowchart 特殊检查
        if content.startswith("flowchart") or content.startswith("graph"):
            # 检查是否有节点连接关系（--> / --- / ==> / -.-> 等）
            link_patterns = ("-->", "---", "==>", "-.->", "--")
            if not any(p in content for p in link_patterns):
                return False, "流程图中缺少节点连接关系"

        return True, ""

    def _check_brackets(self, content: str) -> tuple[bool, str]:
        """检查括号匹配"""
        # 预计算注释区间为集合，O(1)查找
        comment_positions = self._find_comment_positions(content)
        pairs = {"(": ")", "[": "]", "{": "}"}
        stack = []
        in_string = False
        string_char = None
        escape_next = False

        for i, char in enumerate(content):
            if i in comment_positions:
                continue

            if escape_next:
                escape_next = False
                continue
            if char == "\\" and in_string:
                escape_next = True
                continue
            if char in ('"', "'") and not in_string:
                in_string = True
                string_char = char
            elif char == string_char and in_string:
                in_string = False
                string_char = None
            elif not in_string:
                if char in pairs:
                    stack.append((char, i))
                elif char in pairs.values():
                    if not stack:
                        return False, f"多余的闭合括号 '{char}' 在位置 {i}"
                    open_char, open_pos = stack.pop()
                    if pairs.get(open_char) != char:
                        return False, f"括号不匹配: '{open_char}'(位置{open_pos}) 与 '{char}'(位置{i})"

        if stack:
            open_char, pos = stack[-1]
            return False, f"未闭合的括号 '{open_char}' 在位置 {pos}"

        return True, ""

    @staticmethod
    def _find_comment_positions(content: str) -> set[int]:
        """找出所有Mermaid注释字符位置（O(1)查找用）"""
        positions = set()
        for match in re.finditer(r'%%.*', content):
            positions.update(range(match.start(), match.end()))
        return positions

    def _validate_with_cli(self, content: str) -> tuple[bool, str]:
        """使用mermaid-cli校验"""
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".mmd", delete=False, encoding="utf-8") as f:
            f.write(content)
            tmp_path = f.name

        try:
            result = subprocess.run(
                ["mmdc", "-i", tmp_path, "-o", "/dev/null", "-q"],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                return True, "CLI校验通过"
            else:
                error = result.stderr.strip() or "未知CLI错误"
                return False, f"CLI校验失败: {error}"
        except subprocess.TimeoutExpired:
            return False, "CLI校验超时"
        except Exception as e:
            return False, f"CLI校验异常: {e}"
        finally:
            os.unlink(tmp_path)

    def validate_and_report(self, mmd_content: str, diagram_type: str = "") -> str:
        """校验并返回可读的报告"""
        is_valid, msg = self.validate(mmd_content, diagram_type)
        status = "通过" if is_valid else "失败"
        return f"[{status}] {diagram_type or 'Mermaid图'}: {msg}"
