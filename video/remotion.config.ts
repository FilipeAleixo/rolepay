import { Config } from '@remotion/cli/config'

// The recordings live in video/assets/ (gitignored); staticFile('demo-1-setup.mp4')
// reads video/assets/demo-1-setup.mp4.
Config.setPublicDir('./assets')
Config.setEntryPoint('./src/index.ts')
Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(95)
Config.setOverwriteOutput(true)
// Quality over size for the upload: a near-black gradient bands at the default CRF.
Config.setCrf(16)
