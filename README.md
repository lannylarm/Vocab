# Vocab Builder

家庭用英语单词/短语学习程序：查词 → 列出全部英文释义 → 勾选需要的义项录入 → 用"句子填空"复习。

## 功能

- **查词**：输入单词或短语（如 `run`、`take off`、`sweet as`）。依次查询：
  1. Merriam-Webster Learner's（主数据源，包括该词下的短语和习语）
  2. Merriam-Webster Collegiate（仅当 Learner's 查不到时）
  3. Wiktionary（kaikki.org 数据，覆盖新西兰/澳洲俚语，带地区标签）
  4. AI（以上都查不到时自动调用；也可以点 "Ask AI for missing meanings" 补充遗漏的义项，例如 NZ 用法）
- 每个义项显示词性、标签、英文释义和例句；勾选后保存。AI 生成的义项会标记 **AI**。
- 单个单词同时显示英式（UK）和美式（US）IPA 音标，短语不显示。英式音标优先取自 Wiktionary，美式优先取自 MW Learner's；词性不同读音不同时（如 record 名词/动词）分别列出。查不到的音标留空，不用 AI 生成。
- **发音**：UK、US 各有一个 🔊 按钮，点击才播放。优先播放词典录音（英式来自 Wiktionary，美式来自 MW，其次 Wiktionary），没有录音时用设备自带的语音朗读。短语也有发音按钮（设备语音），但不显示音标。右上角 ⚙ 可以开启"自动发音"（默认关闭）并选择自动播放的口音，设置只保存在当前设备。复习时发音按钮在答题后才出现，不会提示答案。
- 查词结果缓存在数据库中 30 天，同一个词不会重复调用 API。
- **复习**：保存义项会立即完成，AI 在服务器后台为每个义项生成 3 个不同的填空句子和 3 个易混淆词（通常几秒到十几秒）。如果复习时还没生成好，会当场补生成；服务器重启后也会自动补齐未完成的。复习时显示句子（挖空），下方显示三个意思或形式相近、但**都不是答案**的干扰词，需要自己**输入**正确的词或短语，并用对形式，例如原形是 `take off`，句子需要 `took off`。
  - 完全正确：等级 +1，按 1/2/4/7/15/30/60/120 天间隔安排下次复习
  - 词对但形式不对（输入原形）：算对，并提示正确形式
  - 错误：等级归零，10 分钟后再出现
  - 每次复习轮换不同的句子
- **我的单词**：查看、筛选、删除已保存义项，或重新生成练习句子。
- **多个学习者**：右上角切换/新增学习者，每人的词库和复习进度独立。
- 一个共享访问密码（`APP_PASSCODE`）保护整个网站，防止他人消耗 API 额度。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Railway Postgres 连接串（引用 `${{Postgres.DATABASE_URL}}`） |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | 默认 `gpt-5.6-luna` |
| `OPENAI_REASONING` | 默认 `low`；如果换用不支持 reasoning 的模型，设为空字符串 |
| `MW_LEARNERS_KEY` | Merriam-Webster Learner's Dictionary key |
| `MW_COLLEGIATE_KEY` | Merriam-Webster Collegiate Dictionary key |
| `APP_PASSCODE` | 网站访问密码（不设置则不需要密码，仅限本地测试） |
| `SESSION_SECRET` | 任意一串随机字符，用于登录 cookie 签名 |
| `PGSSL` | 只有用 Postgres 公网地址连接时设为 `true`；Railway 内网不需要 |

数据表都以 `vocab_` 开头，可以和其他程序共用同一个 Postgres，启动时自动建表。

## 部署到 Railway

1. 把这个文件夹推送到一个新的 GitHub 仓库。
2. 在 Railway 的 `pacific-learning` 项目里 **New → GitHub Repo**，选这个仓库。
3. 在新服务的 **Variables** 里添加上表变量；`DATABASE_URL` 用 **Add Reference** 选择现有 Postgres 服务的 `DATABASE_URL`。
4. **Settings → Networking → Generate Domain** 生成网址。
5. 打开网址，输入访问密码，创建学习者名字即可使用。

## 本地运行

```bash
npm install
cp .env.example .env   # 填好变量
node --env-file=.env server.js
npm test               # 离线测试词典解析
```

## 数据来源与许可

- Merriam-Webster API：免费限非商业用途，每个 key 每天 1000 次。页面底部已标注来源。
- Wiktionary 数据来自 kaikki.org，许可为 CC BY-SA 4.0。
- AI 生成的释义和句子可能有错误，已在界面上标记。
