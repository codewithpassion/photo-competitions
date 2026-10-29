// Creates .dev.vars from the example on first run, so `npm run dev` works out of the box.
import { copyFileSync, existsSync } from 'node:fs'
if (!existsSync('.dev.vars')) copyFileSync('.dev.vars.example', '.dev.vars')
