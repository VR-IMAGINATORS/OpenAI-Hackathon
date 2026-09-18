# 調査 2026-09-18
- 導入済み `codex-cli 0.154.0-alpha.6.2` の `app-server generate-ts --experimental` を runs/codex-poc-schema に生成し型確認。生成物はignored領域であり配布しない。
- ThreadStartParamsにbaseInstructions/developerInstructions/ephemeral、TurnStartParamsにoutputSchema、UserInputにlocalImageを確認。
- ローカルSandboxPolicyはreadOnly+networkAccess。オンライン最新資料にあるrestricted rootsと一致しないため、この版では権限分離の保証を誇張しない。
- 認証はcli_auth_credentials_store=ephemeral。専用HOMEへの通常認証のコピーはしない。
- 公式: https://learn.chatgpt.com/docs/app-server / https://learn.chatgpt.com/docs/config-file/config-reference
- ツールshell/unified_exec/apps/multi_agentを無効化、web_search disabled、read-only、非信頼作業ディレクトリ。予期しないツールitemまたはサーバー要求は失敗で閉じる。
