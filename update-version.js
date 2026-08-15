const fs = require('fs')
const path = require('path')

const pkgPath = path.join(__dirname, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

Object.keys(pkg.optionalDependencies).forEach(k => {
  pkg.optionalDependencies[k] = pkg.version
})

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`Synced optionalDependencies to ${pkg.version}`)
