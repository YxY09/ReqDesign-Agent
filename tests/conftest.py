"""共享测试配置：sys.path设置、通用fixtures"""

import os
import sys

# 确保项目根目录在sys.path中（所有测试文件共用）
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
