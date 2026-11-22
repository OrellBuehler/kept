plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kover)
}

kotlin {
    androidTarget {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    sourceSets {
        androidMain.dependencies {
            implementation(project(":shared"))
            implementation(libs.kotlinx.serialization.json)
        }
    }
}

val appVersion = (findProperty("APP_VERSION") as? String)?.trimStart('v') ?: "dev"
val buildNumber = (findProperty("BUILD_NUMBER") as? String)?.toIntOrNull() ?: 0
// versionCode must strictly increase across every Play upload, including re-runs for
// the same tag. Semver alone made re-runs collide, so the workflow run number is
// folded in; both terms only ever grow.
val computedVersionCode =
    if (appVersion != "dev") {
        val parts = appVersion.split(".").map { it.toIntOrNull() ?: 0 }
        val semverCode = parts.getOrElse(0) { 0 } * 10000 + parts.getOrElse(1) { 0 } * 100 + parts.getOrElse(2) { 0 }
        (semverCode * 1000 + buildNumber).coerceAtLeast(1)
    } else {
        1
    }

android {
    namespace = "ch.orellbuehler.kept"
    compileSdk = 37

    defaultConfig {
        applicationId = "ch.orellbuehler.kept"
        minSdk = 26
        targetSdk = 36
        versionCode = computedVersionCode
        versionName = appVersion
    }

    signingConfigs {
        create("release") {
            val ksFile = System.getenv("ANDROID_KEYSTORE_FILE")
            if (ksFile != null) {
                storeFile = file(ksFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // Without this, a missing ANDROID_KEYSTORE_FILE silently produces an *unsigned*
    // release AAB (the signing config exists but is empty). Fail instead.
    tasks.matching { it.name == "bundleRelease" || it.name == "assembleRelease" }.configureEach {
        doFirst {
            check(System.getenv("ANDROID_KEYSTORE_FILE") != null) {
                "ANDROID_KEYSTORE_FILE is not set — refusing to build an unsigned release artifact"
            }
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // HardcodedText is promoted to error in lint.xml; keep failing the build on
        // lint errors so it is actually enforced.
        abortOnError = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
            all {
                // The page fixtures the server writes (src/routes/api/app/v1/contract.test.ts).
                it.systemProperty("kept.contract.dir", rootProject.file("../src/lib/testing/fixtures/app-contract").absolutePath)
            }
        }
    }

    dependencies {
        implementation(platform(libs.compose.bom))
        implementation(libs.compose.ui)
        implementation(libs.compose.ui.tooling.preview)
        implementation(libs.compose.material3)
        implementation(libs.compose.material.icons)
        implementation(libs.compose.navigation)
        implementation(libs.activity.compose)
        implementation(libs.lifecycle.runtime.compose)
        implementation(libs.lifecycle.viewmodel.compose)
        implementation(libs.kotlinx.datetime)
        implementation(libs.lifecycle.process)
        implementation(libs.kotlinx.coroutines.android)
        implementation(libs.work.runtime)
        implementation(libs.browser)
        debugImplementation(libs.compose.ui.tooling)
        testImplementation(libs.kotlin.test)
        testImplementation(libs.kotlin.test.junit)
        testImplementation(libs.kotlinx.coroutines.test)
        testImplementation(libs.turbine)
        testImplementation(libs.mockk)
    }
}
