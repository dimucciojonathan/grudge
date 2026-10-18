# Records the README GIF with https://github.com/charmbracelet/vhs
#   brew install vhs && node demo/make-demo.js && vhs demo/demo.tape
Output demo/grudge.gif
Set FontSize 18
Set Width 1100
Set Height 640
Set Theme "Catppuccin Mocha"

Hide
Type "export GRUDGE_HOME=/tmp/grudge-demo/home GRUDGE_CLAUDE_DIR=/tmp/grudge-demo/claude GRUDGE_CODEX_DIR=/tmp/grudge-demo/none && clear"
Enter
Show

Type "npx grudge-cc"
Sleep 400ms
Enter
Sleep 4s
