# syntax=docker/dockerfile:1

# Keep AZMCP_SDK in step with the sdk.version in the global.json of AZMCP_REF.
ARG AZMCP_SDK=10.0.403
FROM mcr.microsoft.com/dotnet/sdk:${AZMCP_SDK} AS azmcp
ARG AZMCP_REPO=https://github.com/abossard/mcp.git
# A commit, not a branch: a push to the branch abossard/healthmodels-inspect must not change a deployed image. To move
# to a newer head, set the new commit here and check AZMCP_SDK against its global.json.
ARG AZMCP_REF=b844ad32aa998647ede5368e30512d3901e37770
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 "$AZMCP_REPO" "$AZMCP_REF" \
 && git checkout -q FETCH_HEAD
RUN dotnet publish servers/Azure.Mcp.Server/src/Azure.Mcp.Server.csproj \
      --runtime linux-x64 --self-contained -c Release -o /out \
 && find /out -name '*.pdb' -delete

# The published binary is self-contained, so the runtime needs only its native dependencies. The chiseled image has no
# shell and no package manager and already defines the non-root user "app" (uid 1654); without ICU, .NET needs the
# invariant globalization mode.
FROM mcr.microsoft.com/dotnet/runtime-deps:10.0-noble-chiseled
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    ASPNETCORE_URLS=http://+:8080
COPY --from=azmcp /out /opt/azmcp
USER 1654
EXPOSE 8080
# Remote HTTP mode: every request must carry a user token for this server (scope Mcp.Tools.ReadWrite), which the server
# exchanges on behalf of that user for the downstream ARM and Log Analytics tokens. Read-only, and only the two
# namespaces the agent uses. The Entra settings (AzureAd__*) come from the environment of the Container App.
ENTRYPOINT ["/opt/azmcp/azmcp", "server", "start", \
  "--transport", "http", \
  "--outgoing-auth-strategy", "UseOnBehalfOf", \
  "--mode", "all", \
  "--namespace", "monitor", \
  "--namespace", "group", \
  "--read-only"]
