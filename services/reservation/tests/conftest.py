"""
Reservation 服务测试配置 & 公共 fixtures

pytest 自动发现此文件中的 fixtures，无需在测试文件中显式导入。
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql://skip:skip@localhost/skip")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
os.environ.setdefault("PORT", "8080")
