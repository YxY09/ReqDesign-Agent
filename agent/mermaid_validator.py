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

        content = mmd_content.strip().lstrip('﻿')

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

        # 检查diagram_type与实际内容是否匹配（仅当diagram_type是已知Mermaid关键字时）
        if diagram_type:
            type_to_header = {
                "class_diagram": "classDiagram",
                "classDiagram": "classDiagram",
                "activity_diagram": "flowchart",
                "flowchart": "flowchart",
                "graph": "flowchart",
                "state_diagram": "stateDiagram-v2",
                "stateDiagram-v2": "stateDiagram-v2",
                "stateDiagram": "stateDiagram",
            }
            # 只有当diagram_type是已知映射key时才校验，否则视为显示标签跳过
            if diagram_type in type_to_header:
                expected_header = type_to_header[diagram_type]
                actual_header = next((h for h in valid_headers if content.startswith(h)), "")
                if expected_header != actual_header:
                    expected_norm = type_to_header.get(expected_header, expected_header)
                    actual_norm = type_to_header.get(actual_header, actual_header)
                    if expected_norm != actual_norm:
                        return False, f"声明的图类型 '{diagram_type}' 与实际内容头 '{actual_header}' 不匹配"

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
            # 去除注释后再检查连接关系，避免注释中的箭头误匹配
            comment_positions = self._find_comment_positions(content)
            clean_content = "".join(
                ch for i, ch in enumerate(content) if i not in comment_positions
            )
            link_re = re.compile(r'(?:-->|---|==>|-\.->|\s--\s)')
            if not link_re.search(clean_content):
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
            elif in_string and char == string_char:
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
        """找出所有Mermaid注释字符位置（O(1)查找用），跳过字符串内的%%"""
        positions = set()
        in_string = False
        string_char = None
        escape_next = False
        i = 0
        while i < len(content):
            ch = content[i]
            if escape_next:
                escape_next = False
                i += 1
                continue
            if ch == "\\" and in_string:
                escape_next = True
                i += 1
                continue
            if ch in ('"', "'") and not in_string:
                in_string = True
                string_char = ch
                i += 1
                continue
            if in_string and ch == string_char:
                in_string = False
                string_char = None
                i += 1
                continue
            if not in_string and ch == "%" and i + 1 < len(content) and content[i + 1] == "%":
                # 找到%%注释，标记到行尾
                end = content.find("\n", i)
                if end == -1:
                    end = len(content)
                positions.update(range(i, end))
                i = end
                continue
            i += 1
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
            logger.error(f"CLI校验异常: {e}", exc_info=True)
            return False, f"CLI校验异常: {e}"
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def validate_and_report(self, mmd_content: str, diagram_type: str = "") -> str:
        """校验并返回可读的报告"""
        is_valid, msg = self.validate(mmd_content, diagram_type)
        status = "通过" if is_valid else "失败"
        return f"[{status}] {diagram_type or 'Mermaid图'}: {msg}"
