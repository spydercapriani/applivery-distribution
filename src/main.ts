import * as core from '@actions/core'
import * as github from '@actions/github'
import styles from 'ansi-styles'
import * as fs from 'fs'
import * as QRCode from 'qrcode'
import * as Applivery from './client/applivery.js'
import {
  BuildPlatform,
  CreatePublicationRequest,
  NotifyLanguage
} from './client/models.js'
import * as Utils from './utils.js'

/**
 * Main function for the Applivery Deploy Action
 */
export async function run(): Promise<void> {
  // Get the inputs
  const baseUrl = core.getInput('base-url')
  const baseUploadsUrl = core.getInput('base-uploads-url')
  const apiKey = core.getInput('api-key')
  // Ensure the API key is not accidentally revealed in logs
  core.setSecret(apiKey)
  const publicationPassword = core.getInput('publication-password') || null

  const branchName =
    core.getInput('branch-name') ||
    github.context.payload.pull_request?.head.ref?.replace(
      /^refs\/heads\//,
      ''
    ) ||
    github.context.ref.replace(/^refs\/(heads|pull)\//, '')
  // Replace any character that isn't alphanumeric or hyphen with a hyphen, then trim any leading/trailing hyphens
  const slugSafeBranchName = branchName
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
  const slugName = (
    core.getInput('slug-name') || slugSafeBranchName
  ).toLowerCase()
  const security = core.getInput('publication-password')
    ? Applivery.PublicationSecurity.Password
    : Applivery.PublicationSecurity.Public
  const buildPath = core.getInput('build-path')
  const changelog = core.getInput('changelog')
  const tags = core.getInput('tags')?.split(',') || []

  // Validate the build path
  const buildFile = fs.statSync(buildPath)
  if (!buildFile.isFile()) {
    core.setFailed(
      styles.red.open +
        `Build file does not exist: ${buildPath}` +
        styles.red.close
    )
    return
  }

  // Validate the provided slug name can be used as a slug
  const slugNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]$/
  if (!slugName.match(slugNameRegex) || slugName.length > 128) {
    core.setFailed(
      styles.red.open +
        `Invalid slug-name: ${styles.cyan.open + slugName + styles.cyan.close}. Must start and end with alphanumeric character and contain only alphanumeric characters or hyphens in between. Must be less than 128 characters.` +
        styles.red.close
    )
    return
  }

  try {
    // Upload the build to Applivery
    let uploadedBuild = await Applivery.uploadBuild(
      apiKey,
      baseUploadsUrl,
      buildPath,
      {
        versionName: branchName,
        buildPlatform: BuildPlatform.iOS,
        tags: tags,
        changelog: changelog,
        notifyMessage: `A new build has been uploaded to Applivery for ${branchName}`,
        notifyLanguage: NotifyLanguage.English,
        deployer: Utils.getDeployerInfo(github.context)
      }
    )

    if (core.getInput('skip-processing') !== 'true') {
      let attempts = 0
      const maxAttempts = parseInt(core.getInput('max-attempts'))
      // Convert the wait time to milliseconds
      const waitTime = parseInt(core.getInput('wait-time'))
      // Wait for the build to be processed
      while (uploadedBuild.status !== 'processed' && attempts < maxAttempts) {
        core.debug(
          `Waiting ${waitTime} seconds for build to complete processing... Attempt: ${attempts} of ${maxAttempts}`
        )
        core.debug(
          'Latest Build Status: ' +
            uploadedBuild.status +
            ' (expected: processed)'
        )
        // wait for the specified time before checking the build status again
        await new Promise((resolve) => setTimeout(resolve, waitTime * 1000))
        // check the build status again
        uploadedBuild = await Applivery.getBuild(
          apiKey,
          baseUrl,
          uploadedBuild.id
        )
        attempts++
      }
      if (attempts === maxAttempts) {
        core.error(
          styles.yellow.open +
            `Build did not complete processing after ${maxAttempts} attempts, check the Applivery dashboard for more information...` +
            styles.yellow.close
        )
        throw new Error(
          `Build did not complete processing after ${maxAttempts} attempts`
        )
      }
    }
    core.debug(
      styles.cyan.open +
        `Uploaded build:\n${JSON.stringify(uploadedBuild, null, 2)}` +
        styles.cyan.close
    )

    // Look for existing publications tied to the slug name
    let publication = await Applivery.fetchPublications(apiKey, baseUrl, {
      slug: slugName
    }).then((publications) => {
      return publications
        .map((publication) => {
          return {
            id: publication.id,
            slug: publication.slug,
            distributionUrl: publication.distributionUrl,
            createdAt: publication.createdAt,
            updatedAt: publication.updatedAt
          }
        })
        .find((publication) => publication.slug.toLowerCase() === slugName)
    })

    if (!publication) {
      core.info(
        `No publication found for slug: '${slugName}', will create a new publication...`
      )

      let publicationPayload: CreatePublicationRequest
      if (tags.length > 0) {
        // Create a publication filtered by tags if tags are provided
        publicationPayload = {
          slug: slugName,
          visibility: Applivery.PublicationVisibility.Unlisted,
          security: security,
          password: publicationPassword || '',
          filter: {
            type: Applivery.PublicationFilterType.Tag,
            value: tags.join(',')
          },
          showDevInfo: true,
          showHistory: true
        }
      } else {
        // Default publication will be filtered by branch name
        publicationPayload = {
          slug: slugName,
          visibility: Applivery.PublicationVisibility.Unlisted,
          security: security,
          password: publicationPassword || '',
          filter: {
            type: Applivery.PublicationFilterType.GitBranch,
            value: branchName
          },
          showDevInfo: true,
          showHistory: true
        }
      }

      publication = await Applivery.createPublication(
        apiKey,
        baseUrl,
        publicationPayload
      )
    }

    core.setOutput('publication-id', publication.id)
    core.setOutput('publication-slug', publication.slug)
    core.setOutput('publication-distribution-url', publication.distributionUrl)

    const qrCode = await QRCode.toString(publication.distributionUrl)
    core.setOutput('qr-code', qrCode)
    // Create the Summary Markdown content
    core.summary
      .addRaw(`## [Install App](${publication.distributionUrl})`)
      .addBreak()
      .addRaw(':iphone: Scan this code to install the app on your device.')
      .addBreak()
      .addRaw('\n```\n' + qrCode + '\n```\n')
    if (publicationPassword) {
      core.summary
        .addRaw(':unlock: Installation Password:')
        .addCodeBlock(publicationPassword, 'text')
    }
    core.summary.addSeparator()
    // Write the Summary Markdown
    core.summary.write()

    if (core.isDebug()) {
      console.log(core.summary.stringify())
    }

    core.notice(
      styles.green.open +
        `Build uploaded to ${publication.distributionUrl}` +
        styles.green.close
    )
  } catch (error) {
    if (error instanceof Applivery.AppliveryAPIError) {
      core.error(`Applivery API Error: ${error.statusCode} - ${error.message}`)
    } else if (error instanceof Applivery.AppliveryNetworkError) {
      core.error(`Applivery Network Error: ${error.message}`)
    } else if (error instanceof Applivery.AppliveryParseError) {
      core.error(`Applivery Parse Error: ${error.message}`)
    } else {
      core.error(`Unexpected error: ${error}`)
    }
    core.setFailed(`${error}`)
  }
}
