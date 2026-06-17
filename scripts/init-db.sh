#!/bin/bash
# init-db.sh — 初始化多个数据库（在 PostgreSQL 容器启动时自动执行）
# 由 docker-compose.yml 挂载到 /docker-entrypoint-initdb.d/

set -e

echo "==> Creating databases: reservation_db, member_db"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE reservation_db;
    CREATE DATABASE member_db;
    GRANT ALL PRIVILEGES ON DATABASE reservation_db TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON DATABASE member_db TO $POSTGRES_USER;
EOSQL

echo "==> Databases created successfully"
