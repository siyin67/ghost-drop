# =============================================================================
#  阅后即焚 · P2P 私密聊天室 —— 镜像构建
#  ---------------------------------------------------------------------------
#  构建：docker build -t burn-chat:1.0.0 .
#  运行：docker run -d --name burn-chat \
#          -e ACCESS_CODE='你的服务口令' \
#          -p 127.0.0.1:3001:3000 burn-chat:1.0.0
#
#  说明：
#  * 本项目没有构建步骤（前端是单文件 HTML，Tailwind 走 CDN），
#    因此用单阶段镜像即可，镜像体积小、构建快。
#  * 生产镜像只装 dependencies，不装 devDependencies。
#  * 以非 root 用户 node 运行，进程收到 SIGTERM 会走优雅退出逻辑。
#  * 服务口令（ACCESS_CODE）绝对不打进镜像：它由运行时环境变量传入，
#    或把口令文件挂载到 /app/access-code.txt。两者都没有时进程会随机生成
#    一个临时口令并打印在日志里（重启即失效）。.dockerignore 已排除该文件。
# =============================================================================
FROM node:20-alpine

# ---- 构建参数：国内网络可换成镜像源，例如
#      docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t burn-chat .
ARG NPM_REGISTRY=https://registry.npmjs.org/

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    ACCESS_CODE_FILE=/app/access-code.txt \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# ---- 先拷贝依赖清单，利用 Docker 层缓存：只改代码时不会重新装依赖
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --registry="${NPM_REGISTRY}" \
    && npm cache clean --force

# ---- 再拷贝业务文件（server.js 与 index.html 就是全部）
COPY --chown=node:node server.js index.html ./

USER node

# 3000 只绑定在容器内部，由 compose / nginx 决定暴露方式
EXPOSE 3000

# 容器健康检查：/healthz 返回 {ok:true} 即认为进程可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node 作为 PID 1 直接接收信号；server.js 里已注册 SIGTERM/SIGINT 处理
CMD ["node", "server.js"]
