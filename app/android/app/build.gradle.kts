plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Official Android releases are signed with one long-lived key supplied by the
// release environment. Never make the debug key an implicit fallback: packages
// signed by different keys cannot update one another in place.
val androidAppProject = project
val officialSigningEnvironment = mapOf(
    "storeFile" to System.getenv("MULTICC_ANDROID_KEYSTORE_PATH"),
    "storePassword" to System.getenv("MULTICC_ANDROID_STORE_PASSWORD"),
    "keyAlias" to System.getenv("MULTICC_ANDROID_KEY_ALIAS"),
    "keyPassword" to System.getenv("MULTICC_ANDROID_KEY_PASSWORD"),
)
val officialSigningConfigured = officialSigningEnvironment.values.all { !it.isNullOrBlank() }
val officialSigningPartiallyConfigured = officialSigningEnvironment.values.any { !it.isNullOrBlank() }
if (officialSigningPartiallyConfigured && !officialSigningConfigured) {
    throw GradleException("Official release signing is only partially configured")
}

android {
    namespace = "com.multicc.multicc_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = "27.0.12077973"

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.multicc.multicc_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 23
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (officialSigningConfigured) {
            create("officialRelease") {
                storeFile = file(officialSigningEnvironment.getValue("storeFile")!!)
                storePassword = officialSigningEnvironment.getValue("storePassword")
                keyAlias = officialSigningEnvironment.getValue("keyAlias")
                keyPassword = officialSigningEnvironment.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (officialSigningConfigured) {
                signingConfig = signingConfigs.getByName("officialRelease")
            }
        }
    }
}

// Keep debug builds usable without secrets, but refuse every release task before
// execution if the official key is absent. An unsigned or debug-signed artifact
// must never be mistaken for the official update channel.
gradle.taskGraph.whenReady {
    val releaseRequested = allTasks.any { task ->
        task.project == androidAppProject && task.name.contains("Release", ignoreCase = true)
    }
    if (releaseRequested && !officialSigningConfigured) {
        throw GradleException("Official release signing is required for Android release tasks")
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

flutter {
    source = "../.."
}
