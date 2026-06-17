"""
NekoCafé 预约服务 — 需要将此文件放在 src 包的根目录下，使 `from src.main import app` 能够正常导入
package (reservation)

模块说明：
- main    : FastAPI 应用入口，包含路由 / 中间件 / 指标 / 生命周期管理
- 运行方式: uvicorn src.main:app --host 0.0.0.0 --port 8080
- 测试方式: pytest tests/ -v --tb=short --cov=src
"""

__version__ = "1.0.0"
__all__ = ["main"]
