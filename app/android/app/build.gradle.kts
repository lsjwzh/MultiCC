import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Optional client configuration; never load a service-account key into an APK.
val firebaseConfigFile = file(System.getenv("MULTICC_FIREBASE_ANDROID_CONFIG") ?: "google-services.json")
val firebaseConfig = if (firebaseConfigFile.exists()) {
    JsonSlurper().parse(firebaseConfigFile) as Map<*, *>
} else emptyMap<String, Any>()
val firebaseProject = firebaseConfig["project_info"] as? Map<*, *> ?: emptyMap<String, Any>()
val firebaseClient = (firebaseConfig["client"] as? List<*>)?.mapNotNull { it as? Map<*, *> }?.firstOrNull {
    val info = it["client_info"] as? Map<*, *>
    (info?.get("android_client_info") as? Map<*, *>)?.get("package_name") == "com.multicc.multicc_app"
}
if (firebaseConfigFile.exists() && firebaseClient == null) {
    throw GradleException("Firebase Android config does not match com.multicc.multicc_app")
}
val firebaseInfo = firebaseClient?.get("client_info") as? Map<*, *>
val firebaseApiKey = (firebaseClient?.get("api_key") as? List<*>)?.firstOrNull() as? Map<*, *>

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
        resValue("string", "multicc_fcm_app_id", firebaseInfo?.get("mobilesdk_app_id")?.toString() ?: "")
        resValue("string", "multicc_fcm_project_id", firebaseProject["project_id"]?.toString() ?: "")
        resValue("string", "multicc_fcm_sender_id", firebaseProject["project_number"]?.toString() ?: "")
        resValue("string", "multicc_fcm_api_key", firebaseApiKey?.get("current_key")?.toString() ?: "")
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
    testImplementation("junit:junit:4.13.2")
    implementation(platform("com.google.firebase:firebase-bom:33.16.0"))
    implementation("com.google.firebase:firebase-messaging")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

flutter {
    source = "../.."
}
