# OpenCode install

Add cogsend to `opencode.json`:

```json
{
	"plugins": ["cogsend@git+https://github.com/deepakness/cogsend.git"]
}
```

On OpenCode 1.x use the singular key `"plugin"` with the same value.

Alternatively copy `skills/cogsend/` from this repo into your project's skills
directory.

Restart OpenCode after changing the config. Set `APP_URL` and `COGSEND_API_KEY`
in your environment before using the skill.
